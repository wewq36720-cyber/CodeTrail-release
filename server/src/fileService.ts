import { getCourseById } from './scanner.js'
import { getAll, getLddPath } from './db/index.js'
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'fs'
import { join, relative, resolve, extname } from 'path'

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', '.agents', 'dist', 'build', '.idea', '.vscode', '.learndesk'])
const MAX_FILE_SIZE = 2 * 1024 * 1024   // FR-12：>2MB 截断
const CHUNK_SIZE = 256 * 1024
const SHALLOW_FILE_LIMIT = 2000         // 05 风险表：>2000 文件启用浅层模式

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtime?: number
  children?: FileNode[]
  group?: string
  isRouteFile?: boolean
}

const GROUP_PATTERNS: [RegExp, string][] = [
  [/^README\.md$/i, '📖 文档与指南'],
  [/^docs?\//i, '📖 文档与指南'],
  [/^(examples?|samples?|cookbook)\//i, '🧩 示例'],
  [/^(src|lib|pkg|agent|agents|core)\//i, '📦 核心源码']
]

function getGroup(path: string, routeFiles: Set<string>): string {
  if (routeFiles.has(path)) return '🚩 路线文件'
  for (const [pattern, group] of GROUP_PATTERNS) {
    if (pattern.test(path)) return group
  }
  return '🛠 其他'
}

export function getFileTree(courseId: string): { tree: FileNode[]; groups: string[]; truncated: boolean; totalFiles: number } {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')
  if (!existsSync(course.root)) {
    return { tree: [], groups: [], truncated: false, totalFiles: 0 }
  }

  const routeFiles = new Set<string>()
  for (const row of getAll('SELECT def_path FROM routes WHERE course_id = ?', [courseId]) as any[]) {
    try {
      const routeDef = JSON.parse(readFileSync(row.def_path, 'utf8'))
      for (const step of routeDef.steps || []) {
        if (step.file) routeFiles.add(step.file.replace(/\\/g, '/'))
      }
    } catch {}
  }

  let totalFiles = 0
  let truncated = false
  const buildTree = (dir: string, depth: number): FileNode[] => {
    if (depth > 10 || truncated) return []
    let entries: any[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    const nodes: FileNode[] = []

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      if (totalFiles >= SHALLOW_FILE_LIMIT) { truncated = true; break }
      const fullPath = join(dir, entry.name)
      const relPath = relative(course.root, fullPath).replace(/\\/g, '/')
      let statInfo: any
      try { statInfo = statSync(fullPath) } catch { continue }

      if (entry.isDirectory()) {
        const children = buildTree(fullPath, depth + 1)
        if (children.length > 0) {
          nodes.push({
            name: entry.name, path: relPath, type: 'directory',
            mtime: statInfo.mtimeMs, children, group: getGroup(relPath + '/', routeFiles)
          })
        }
      } else {
        totalFiles++
        nodes.push({
          name: entry.name, path: relPath, type: 'file',
          size: statInfo.size, mtime: statInfo.mtimeMs,
          group: getGroup(relPath, routeFiles),
          isRouteFile: routeFiles.has(relPath) || undefined
        })
      }
    }

    return nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  const tree = buildTree(course.root, 0)
  const groups = ['🚩 路线文件', '📖 文档与指南', '🧩 示例', '📦 核心源码', '🛠 其他']
  return { tree, groups, truncated, totalFiles }
}

// ---------- 懒加载目录（树 v2：展开时按需取一层子节点） ----------

export type SortKey = 'name' | 'size' | 'mtime'

export function getDirectory(courseId: string, relDir: string, sort: SortKey = 'name'): {
  path: string
  nodes: FileNode[]
  fileCount: number
  dirCount: number
  truncated: boolean
} {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')

  const dirAbs = relDir ? resolve(course.root, relDir) : resolve(course.root)
  if (!dirAbs.toLowerCase().startsWith(resolve(course.root).toLowerCase())) throw new Error('Path traversal denied')
  if (!existsSync(dirAbs)) throw new Error('Directory not found')

  const routeFiles = new Set<string>()
  for (const row of getAll('SELECT def_path FROM routes WHERE course_id = ?', [courseId]) as any[]) {
    try {
      const routeDef = JSON.parse(readFileSync(row.def_path, 'utf8'))
      for (const step of routeDef.steps || []) {
        if (step.file) routeFiles.add(step.file.replace(/\\/g, '/'))
      }
    } catch {}
  }

  let entries: any[]
  try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { entries = [] }

  const nodes: FileNode[] = []
  let fileCount = 0
  let dirCount = 0
  let truncated = false

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue
    const fullPath = join(dirAbs, entry.name)
    const relPath = relDir ? relDir + '/' + entry.name : entry.name
    let statInfo: any
    try { statInfo = statSync(fullPath) } catch { continue }

    if (entry.isDirectory()) {
      dirCount++
      nodes.push({ name: entry.name, path: relPath, type: 'directory', mtime: statInfo.mtimeMs })
    } else {
      fileCount++
      if (nodes.length >= 800) { truncated = true; continue }  // 单目录超 800 项截断保护
      nodes.push({
        name: entry.name, path: relPath, type: 'file',
        size: statInfo.size, mtime: statInfo.mtimeMs,
        isRouteFile: routeFiles.has(relPath) || undefined
      })
    }
  }

  const sorters: Record<SortKey, (a: FileNode, b: FileNode) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    mtime: (a, b) => (b.mtime || 0) - (a.mtime || 0)
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return sorters[sort](a, b)
  })

  return { path: relDir.replace(/\\/g, '/'), nodes, fileCount, dirCount, truncated }
}

// 深度搜索（懒加载树不能纯前端过滤 → 服务端一次走全树返回匹配路径，上限 300 条）
export function searchCourseFiles(courseId: string, query: string, limit = 300): Array<{ path: string; name: string; type: 'file' | 'directory' }> {
  const course = getCourseById(courseId)
  if (!course || !query) return []
  const root = course.root
  const q = query.toLowerCase()
  const out: Array<{ path: string; name: string; type: 'file' | 'directory' }> = []

  const walk = (dir: string, depth: number) => {
    if (depth > 10 || out.length >= limit) return
    let entries: any[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue
      if (out.length >= limit) return
      const fullPath = join(dir, entry.name)
      const relPath = relative(root, fullPath).replace(/\\/g, '/')
      if (entry.name.toLowerCase().includes(q)) {
        out.push({ path: relPath, name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })
      }
      if (entry.isDirectory()) walk(fullPath, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

// 编码兜底：UTF-8 优先，检测到替代符回退 GBK（NF-04）
function decodeBuffer(buffer: Buffer): { content: string; encoding: string } {
  const text = buffer.toString('utf8')
  if (text.includes('\uFFFD')) {
    try { return { content: new TextDecoder('gbk').decode(buffer), encoding: 'gbk' } } catch {}
    return { content: text, encoding: 'utf8' }
  }
  return { content: text, encoding: 'utf8' }
}

// ---------- FR-12 v2：分片读取 ----------
// 默认全量（≤512KB）；大文件按行区间窗口返回，前端按需续载（GitLab/CodeMirror 的 chunked 模式）

const FULL_READ_LIMIT = 512 * 1024
const DEFAULT_WINDOW_LINES = 2000

export function getFileContent(
  courseId: string,
  relPath: string,
  opts: { startLine?: number; endLine?: number } = {}
): {
  content: string
  truncated: boolean
  encoding: string
  startLine: number
  endLine: number
  totalLines: number
  partial: boolean
} {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')

  const fullPath = resolve(course.root, relPath)
  if (!fullPath.toLowerCase().startsWith(resolve(course.root).toLowerCase())) throw new Error('Path traversal denied')
  if (!existsSync(fullPath)) throw new Error('File not found')

  const statInfo = statSync(fullPath)
  if (statInfo.isDirectory()) throw new Error('Not a file')

  // >2MB 文件仍只解码首段 256KB（防止超大文件全量解码卡死）
  const raw = statInfo.size > MAX_FILE_SIZE ? readFileSync(fullPath).subarray(0, CHUNK_SIZE) : readFileSync(fullPath)
  const { content: full, encoding } = decodeBuffer(raw)

  const allLines = full.split('\n')
  const totalLines = allLines.length
  const size = statInfo.size

  // 小文件：全量返回
  if (size <= FULL_READ_LIMIT) {
    return {
      content: allLines.join('\n'), truncated: size > MAX_FILE_SIZE, encoding,
      startLine: 1, endLine: totalLines, totalLines, partial: false
    }
  }

  // 大文件：窗口读取
  const startLine = Math.max(1, opts.startLine ?? 1)
  const requestedEnd = opts.endLine ?? Math.min(totalLines, startLine - 1 + DEFAULT_WINDOW_LINES)
  const endLine = Math.min(totalLines, requestedEnd)
  const windowLines = allLines.slice(startLine - 1, endLine)

  return {
    content: windowLines.join('\n'),
    truncated: size > MAX_FILE_SIZE,
    encoding,
    startLine,
    endLine,
    totalLines,
    partial: endLine < totalLines || startLine > 1
  }
}

export function getFileHead(courseId: string): string {
  const course = getCourseById(courseId)
  if (!course) return ''
  const readmePath = join(course.root, 'README.md')
  if (existsSync(readmePath)) {
    return readFileSync(readmePath, 'utf8').split('\n').slice(0, 5).join('\n')
  }
  return ''
}

// ---------- FR-14 书签（存 LDD，不碰仓库） ----------

const BOOKMARKS_FILE = join(getLddPath(), 'bookmarks.json')

type BookmarkStore = Record<string, Record<string, number[]>>

function loadBookmarks(): BookmarkStore {
  try { return JSON.parse(readFileSync(BOOKMARKS_FILE, 'utf8')) } catch { return {} }
}

export function getBookmarks(courseId: string): Record<string, number[]> {
  return loadBookmarks()[courseId] || {}
}

export function setBookmarks(courseId: string, relPath: string, lines: number[]): { lines: number[] } {
  const store = loadBookmarks()
  if (!store[courseId]) store[courseId] = {}
  const cleaned = [...new Set(lines)].filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
  if (cleaned.length === 0) delete store[courseId][relPath]
  else store[courseId][relPath] = cleaned.slice(0, 200)
  try { writeFileSync(BOOKMARKS_FILE, JSON.stringify(store, null, 2)) } catch {}
  return { lines: store[courseId]?.[relPath] || [] }
}

export { getLddPath }

// ---------- 扁平文件清单（搜索/快速打开；优先索引，含角色与重要度） ----------
import { getIndex } from './indexer.js'

export function getFlatFiles(courseId: string): Array<{ path: string; role?: string; score?: number; lines?: number }> {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')
  try {
    const idx = getIndex(courseId)
    if (idx) return idx.files.map(f => ({ path: f.path, role: f.role, score: f.score, lines: f.lines }))
  } catch {}
  const out: Array<{ path: string }> = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length > 5000) return
    let entries: any[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else out.push({ path: relative(course.root, full).replace(/\\/g, '/') })
    }
  }
  walk(course.root, 0)
  return out
}
