import { readdir, stat } from 'fs/promises'
import { join, relative, basename } from 'path'
import { execSync } from 'child_process'
import { readFileSync, readdirSync, existsSync, statSync, appendFileSync } from 'fs'
import { getRoots, getSettings, saveSettings, isDebug } from './settings.js'
import { resolveFsPath } from './paths.js'
import { run, getRow, getAll } from './db/index.js'

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', '.agents', 'dist', 'build', '.idea', '.vscode', '.learndesk'])

let logEnabled = false
function log(msg: string) {
  if (!logEnabled) return
  appendFileSync(join(process.cwd(), 'scanner-debug.log'), msg + '\n')
}

function detectLanguage(dir: string): string {
  const manifests: Record<string, string> = {
    'pyproject.toml': 'python', 'requirements.txt': 'python', 'setup.py': 'python',
    'go.mod': 'go', 'package.json': 'javascript', 'Cargo.toml': 'rust'
  }
  const langs = new Set<string>()
  const scan = (d: string, depth: number) => {
    if (depth > 2) return
    let entries: any[] = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isFile() && manifests[e.name]) langs.add(manifests[e.name])
      else if (e.isDirectory() && !IGNORE_DIRS.has(e.name)) scan(join(d, e.name), depth + 1)
      if (langs.size > 1) return
    }
  }
  scan(dir, 0)
  if (langs.size >= 2) return 'multi'
  if (langs.has('python')) return 'python'
  if (langs.has('go')) return 'go'
  if (langs.has('javascript')) return 'javascript'
  if (langs.has('rust')) return 'rust'
  return 'unknown'
}

function getGitInfo(dir: string): { remote?: string; lastCommit?: number } {
  try {
    const remote = execSync(`git -C "${dir}" remote get-url origin`, { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const lastCommit = execSync(`git -C "${dir}" log -1 --format=%ct`, { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return { remote, lastCommit: parseInt(lastCommit) * 1000 }
  } catch {
    return {}
  }
}

interface WalkStats { files: number; dirs: number; bytes: number; truncated: boolean }

// 体量统计（FR-03）：带 ignore 集的受限遍历，防超大仓库拖慢扫描
function walkStats(dir: string, maxFiles = 5000, depth = 0): WalkStats {
  const acc: WalkStats = { files: 0, dirs: 0, bytes: 0, truncated: false }
  const walk = (d: string, dep: number) => {
    if (acc.truncated || dep > 8) return
    let entries: any[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        acc.dirs++
        walk(p, dep + 1)
      } else {
        acc.files++
        try { acc.bytes += statSync(p).size } catch {}
      }
      if (acc.files >= maxFiles) { acc.truncated = true; return }
    }
  }
  walk(dir, depth)
  return acc
}

function classifyCourse(dir: string, hasGit: boolean, lang: string, stats: WalkStats): { kind: 'repo' | 'docs'; label: string; tags: string[] } {
  if (!hasGit) {
    return { kind: 'docs', label: '文档课程', tags: ['文档族', 'T7'] }
  }
  let tier = 'T3'
  const hasMonorepoLayout = ['libs', 'packages', 'libs/python'].some(d => existsSync(join(dir, d)))
  if (lang === 'multi' || lang === 'rust') tier = 'T6'
  else if (hasMonorepoLayout) tier = 'T4'
  else if (stats.files > 2500 || stats.bytes > 30 * 1024 * 1024) tier = 'T5'
  const langLabel = { python: 'Python 框架', go: 'Go 框架', javascript: 'JS/TS 框架', multi: '多语言 SDK', rust: 'Rust 框架', unknown: '源码仓库' }[lang] || '源码仓库'
  return { kind: 'repo', label: langLabel, tags: ['仓库族', tier] }
}

function getReadmeSummary(dir: string): string {
  for (const name of ['README.md', 'README.rst', 'README.txt', 'readme.md']) {
    try {
      const content = readFileSync(join(dir, name), 'utf8')
      return content.split('\n').slice(0, 5).join('\n')
    } catch {}
  }
  return ''
}

function listMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map(e => e.name)
  } catch { return [] }
}

export async function scanRoots() {
  logEnabled = isDebug()
  log('[Scanner] Starting scanRoots...')
  const roots = getRoots()
  const settings = getSettings()
  const scanCache = settings.scanCache || {}
  const now = Date.now()

  // 旧版所有根共用 'docs:__root__' 一个 id，多根时互相覆盖；一次性清理（新方案按根分 id）
  run("DELETE FROM courses WHERE id = 'docs:__root__'")

  for (const root of roots) {
    // 容器挂载环境下 Windows 路径按 LEARNDESK_PATH_MAP 映射到挂载点
    const rootPath = resolveFsPath(root.path)
    let entries: any[]
    try {
      entries = await readdir(rootPath, { withFileTypes: true })
    } catch (e) {
      log(`[Scanner] Root unreadable: ${rootPath}: ${e}`)
      continue
    }

    // 第一层子目录（FR-02）；隐藏目录（.codegraph/.omo 等工具目录）不作为课程
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      if (IGNORE_DIRS.has(entry.name)) continue
      if (entry.name === '.learndesk' || entry.name === 'app') continue

      const fullPath = join(rootPath, entry.name)
      let statInfo
      try { statInfo = await stat(fullPath) } catch { continue }
      const cacheKey = fullPath
      if (statInfo.mtimeMs <= (scanCache[cacheKey] || 0)) continue

      const hasGit = existsSync(join(fullPath, '.git'))
      const lang = detectLanguage(fullPath)
      const { remote, lastCommit } = getGitInfo(fullPath)
      const stats = walkStats(fullPath)
      const classification = classifyCourse(fullPath, hasGit, lang, stats)
      const readmeSummary = getReadmeSummary(fullPath)
      const courseId = `${classification.kind}:${relative(rootPath, fullPath).replace(/\\/g, '/')}`

      upsertCourse({
        id: courseId, kind: classification.kind, root: fullPath, slug: entry.name, lang,
        label: classification.label, tags: classification.tags, missing: 0,
        scanMeta: { remote, lastCommit, readmeSummary, fileCount: stats.files, dirCount: stats.dirs, sizeBytes: stats.bytes, truncated: stats.truncated },
        lastScanAt: now
      })
      scanCache[cacheKey] = statInfo.mtimeMs
    }

    // 根目录散落 md → 聚为「根目录文档」课程（FR-02）
    const mdFiles = listMdFiles(rootPath)
    if (mdFiles.length > 0) {
      const maxMdMtime = mdFiles.reduce((m, f) => Math.max(m, statSync(join(rootPath, f)).mtimeMs), 0)
      // v2 后缀：旧缓存键会让新 id 方案首扫被跳过，换键强制重建一次
      const cacheKey = join(rootPath, '__root_docs_v2__')
      if (maxMdMtime > (scanCache[cacheKey] || 0)) {
        upsertCourse({
          id: `docs:__root__:${basename(rootPath).toLowerCase()}`, kind: 'docs', root: rootPath, slug: `${basename(rootPath)}·文档`, lang: 'markdown',
          label: '文档课程', tags: ['文档族', 'T7'], missing: 0,
          scanMeta: { remote: '', lastCommit: undefined, readmeSummary: `共 ${mdFiles.length} 个 md 文档`, fileCount: mdFiles.length, dirCount: 0, sizeBytes: 0, mdFiles: mdFiles.slice(0, 50) },
          lastScanAt: now
        })
        scanCache[cacheKey] = maxMdMtime
      }
    }
  }

  saveSettings({ scanCache })
  log('[Scanner] Scan complete')
}

function upsertCourse(c: {
  id: string; kind: string; root: string; slug: string; lang: string; label: string
  tags: string[]; missing: number; scanMeta: any; lastScanAt: number
}) {
  run(`
    INSERT INTO courses (id, kind, root, slug, lang, label, tags, scan_meta, missing, last_scan_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, root=excluded.root, slug=excluded.slug, lang=excluded.lang,
      label=excluded.label, tags=excluded.tags, scan_meta=excluded.scan_meta,
      missing=excluded.missing, last_scan_at=excluded.last_scan_at
  `, [c.id, c.kind, c.root, c.slug, c.lang, c.label, JSON.stringify(c.tags), JSON.stringify(c.scanMeta), c.missing, c.lastScanAt])
}

function courseVisible(row: any): boolean {
  // 旧库里遗留的隐藏目录课程（.codegraph/.omo 等工具目录）不再呈现
  if (String(row.slug || '').startsWith('.')) return false
  // 库内存的是解析后的真实路径（容器内可能是 /workspace/...），与配置根路径映射后再比较
  const roots = getRoots().map(r => resolveFsPath(r.path).toLowerCase())
  return roots.some(rp => row.root?.toLowerCase().startsWith(rp))
}

export function getCourses() {
  // 仓库课程在前、文档课程在后，各按名称排序——列表顺序稳定可预期
  const rows = getAll(`
    SELECT * FROM courses
    ORDER BY CASE kind WHEN 'repo' THEN 0 ELSE 1 END, slug COLLATE NOCASE
  `)
  const visible = rows.filter(courseVisible)
  // D 场景：课程目录被删 → 标记缺失而不是消失/崩溃
  for (const row of visible) {
    const missing = existsSync(row.root) ? 0 : 1
    if (missing !== (row.missing || 0)) {
      run('UPDATE courses SET missing = ? WHERE id = ?', [missing, row.id])
      row.missing = missing
    }
    row.tags = safeParse(row.tags, [])
    row.scan_meta = safeParse(row.scan_meta, {})
  }
  return visible
}

export function getCourseById(id: string) {
  const row = getRow('SELECT * FROM courses WHERE id = ?', [id]) as any
  if (row) {
    row.tags = safeParse(row.tags, [])
    row.scan_meta = safeParse(row.scan_meta, {})
  }
  return row
}

function safeParse(text: any, fallback: any) {
  if (typeof text !== 'string') return text ?? fallback
  try { return JSON.parse(text) } catch { return fallback }
}

export function updateCourseTags(id: string, tags: string[]) {
  run('UPDATE courses SET tags = ? WHERE id = ?', [JSON.stringify(tags), id])
}
