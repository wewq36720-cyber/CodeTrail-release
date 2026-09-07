// 代码索引器 —— 调研结论的落地（见 docs/ 相关说明）
// aider Repo Map 轻量版：符号提取(python ast / js·go 正则) → 内部依赖图 → PageRank 排序 → 角色判定
// 索引持久化在 LDD/index/<course>.json，以 git HEAD 为失效键（读取存入）
import { spawn, execSync } from 'child_process'
import { getCourseById } from './scanner.js'
import { getLddPath } from './db/index.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, resolve, basename } from 'path'

export interface FileSymbol { name: string; kind: 'class' | 'function' | 'method' | 'type' | 'const'; line: number; end: number; doc: string }
export type FileRole = 'core' | 'entry' | 'example' | 'doc' | 'test' | 'config' | 'other'

export interface IndexedFile {
  path: string
  lang: string
  lines: number
  size: number
  symbols: FileSymbol[]
  imports: string[]      // 解析出的内部依赖（相对路径 / 分隔）
  importedBy: string[]
  score: number          // PageRank 0~100
  role: FileRole
  readingMinutes: number
}

const ALGO_VERSION = 2 // 评分公式/入口判定变更时递增，旧缓存自动标记 stale

export interface CourseIndex {
  courseId: string
  head: string | null
  generatedAt: number
  stale?: boolean
  algoVersion?: number
  files: IndexedFile[]
  stats: { total: number; code: number; docs: number; tests: number; examples: number; pythonOk: boolean }
  topCore: string[]      // 按重要性排序的核心文件（≤8）
  entries: string[]
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', '.agents', 'dist', 'build', '.idea', '.vscode', '.learndesk'])
const CODE_EXT = new Set(['.py', '.go', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'])
const DOC_EXT = new Set(['.md', '.rst', '.txt'])

function indexDir(courseId: string) {
  const dir = join(getLddPath(), 'index')
  mkdirSync(dir, { recursive: true })
  return join(dir, courseId.replace(/[\\/:*?"<>|]/g, '_') + '.json')
}

function gitHead(root: string): string | null {
  try {
    return execSync(`git -C "${root}" rev-parse HEAD`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()
  } catch { return null }
}

// ---------- Python 符号提取：uv run python + ast（一次性解析全仓库） ----------
const PY_EXTRACT_SCRIPT = `
import sys, os, json, ast
root = sys.argv[1]
SKIP = {'.git','node_modules','.venv','venv','__pycache__','target','.agents','dist','build','.idea','.vscode','.learndesk'}
files = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in SKIP]
    for fn in filenames:
        if fn.endswith('.py'):
            files.append(os.path.join(dirpath, fn))

def resolve_module(mod, level, cur_dir):
    # 相对/绝对 import → 仓库内文件相对路径（解析不到返回 None）
    base = cur_dir
    for _ in range(level - 1):
        base = os.path.dirname(base)
    parts = mod.split('.') if mod else []
    cand = os.path.join(base, *parts)
    for c in (cand + '.py', os.path.join(cand, '__init__.py')):
        rp = os.path.relpath(c, root)
        if not rp.startswith('..') and os.path.exists(c):
            return rp.replace('\\\\', '/')
    return None

out = []
for p in files:
    rel = os.path.relpath(p, root).replace('\\\\', '/')
    try:
        raw = open(p, 'rb').read()
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            text = raw.decode('gbk', 'replace')
    except Exception:
        continue
    try:
        tree = ast.parse(text)
    except SyntaxError:
        out.append({'path': rel, 'ok': False})
        continue
    syms, imports = [], []
    cur_dir = os.path.dirname(p)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = 'class' if isinstance(node, ast.ClassDef) else 'function'
            if any(s['line'] >= node.lineno and s['end'] <= getattr(node, 'end_lineno', node.lineno) for s in syms):
                pass
            doc = ast.get_docstring(node)
            syms.append({'name': node.name, 'kind': kind, 'line': node.lineno,
                         'end': getattr(node, 'end_lineno', node.lineno),
                         'doc': (doc or '').strip().split('\\n')[0][:120]})
        elif isinstance(node, ast.Import):
            for a in node.names:
                rp = resolve_module(a.name, 0, cur_dir)
                if rp: imports.append(rp)
        elif isinstance(node, ast.ImportFrom):
            rp = resolve_module(node.module or '', node.level or 0, cur_dir)
            if rp: imports.append(rp)
            elif node.level and node.level >= 1:
                # from . import x → 目录 __init__ 或同名文件
                base = cur_dir
                for _ in range(node.level - 1):
                    base = os.path.dirname(base)
                for name in (a.name for a in node.names):
                    for c in (os.path.join(base, name + '.py'), os.path.join(base, name, '__init__.py')):
                        rp2 = os.path.relpath(c, root)
                        if not rp2.startswith('..') and os.path.exists(c):
                            imports.append(rp2.replace('\\\\', '/'))
    out.append({'path': rel, 'ok': True, 'lines': text.count('\\n') + 1,
                'symbols': syms, 'imports': sorted(set(imports))})
print(json.dumps(out))
`

function extractPython(root: string): Promise<Map<string, { lines: number; symbols: FileSymbol[]; imports: string[] }>> {
  return new Promise(resolveP => {
    const child = spawn('uv', ['run', 'python', '-', root], {
      cwd: getLddPath(),
      windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: join(getLddPath(), 'tmp', 'pycache') }
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { err += c })
    child.on('error', () => { clearTimeout(timer); resolveP(new Map()) })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const arr = JSON.parse(out.trim().split('\n').filter(l => l.trim().startsWith('[')).pop() || out.trim())
        const map = new Map<string, any>()
        for (const f of arr) {
          if (f.ok) map.set(f.path, { lines: f.lines, symbols: f.symbols, imports: f.imports })
        }
        resolveP(map)
      } catch {
        console.error('[Indexer] python 解析失败:', err.slice(0, 300))
        resolveP(new Map())
      }
    })
    child.stdin.write(PY_EXTRACT_SCRIPT)
    child.stdin.end()
  })
}

// ---------- JS/TS/Go 正则提取 ----------
function extractJs(relPath: string, text: string): { symbols: FileSymbol[]; imports: string[] } {
  const symbols: FileSymbol[] = []
  const imports: string[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    let m
    if ((m = line.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/))) {
      symbols.push({ name: m[1], kind: 'class', line: i + 1, end: i + 1, doc: '' })
    } else if ((m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) {
      symbols.push({ name: m[1], kind: 'function', line: i + 1, end: i + 1, doc: '' })
    } else if ((m = line.match(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) {
      symbols.push({ name: m[1], kind: 'function', line: i + 1, end: i + 1, doc: '' })
    }
    let im
    const re = /(?:import[^'"]*?from\s*|require\(\s*|import\()\s*['"]([^'"]+)['"]/g
    while ((im = re.exec(line))) imports.push(im[1])
  })
  return { symbols, imports }
}

function extractGo(relPath: string, text: string, moduleRoot: string | null): { symbols: FileSymbol[]; imports: string[] } {
  const symbols: FileSymbol[] = []
  const imports: string[] = []
  const lines = text.split('\n')
  let inImportBlock = false
  lines.forEach((line, i) => {
    if (/^\s*import\s+\(/.test(line)) { inImportBlock = true; return }
    if (inImportBlock) {
      const m = line.match(/"([^"]+)"/)
      if (m) imports.push(m[1])
      if (/\)/.test(line)) inImportBlock = false
      return
    }
    let m
    if ((m = line.match(/^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/))) {
      symbols.push({ name: m[1], kind: 'function', line: i + 1, end: i + 1, doc: '' })
    } else if ((m = line.match(/^\s*type\s+([A-Za-z_][\w]*)\s+(?:struct|interface)/))) {
      symbols.push({ name: m[1], kind: 'class', line: i + 1, end: i + 1, doc: '' })
    } else if ((m = line.match(/^\s*import\s+"([^"]+)"/))) {
      imports.push(m[1])
    }
  })
  // go import path → 内部文件：module 名前缀匹配
  const internal: string[] = []
  if (moduleRoot) {
    for (const imp of imports) {
      if (imp.startsWith(moduleRoot)) {
        const suffix = imp.slice(moduleRoot.length).replace(/\//g, '/')
        internal.push(suffix.replace(/^\//, '') + '.go')
      }
    }
  }
  return { symbols, imports: internal }
}

function readGoModuleName(root: string): string | null {
  try {
    const m = readFileSync(join(root, 'go.mod'), 'utf8').match(/^module\s+(\S+)/m)
    return m ? m[1] : null
  } catch { return null }
}

// ---------- PageRank ----------
function pagerank(nodes: string[], edges: Map<string, string[]>): Map<string, number> {
  const N = nodes.length
  const rank = new Map<string, number>()
  if (N === 0) return rank
  const outDeg = new Map<string, number>()
  const incoming = new Map<string, string[]>()
  for (const n of nodes) { rank.set(n, 1 / N); outDeg.set(n, edges.get(n)?.length || 0); incoming.set(n, []) }
  for (const [from, tos] of edges) {
    for (const to of tos) {
      if (incoming.has(to)) incoming.get(to)!.push(from)
    }
  }
  const d = 0.85
  for (let it = 0; it < 30; it++) {
    const next = new Map<string, number>()
    let dangling = 0
    for (const n of nodes) if (outDeg.get(n) === 0) dangling += rank.get(n)!
    for (const n of nodes) {
      let sum = 0
      for (const inNode of incoming.get(n)!) {
        sum += (rank.get(inNode)! / Math.max(1, outDeg.get(inNode)!))
      }
      next.set(n, (1 - d) / N + d * (sum + dangling / N))
    }
    for (const [n, v] of next) rank.set(n, v)
  }
  // 归一化到 0~100
  const max = Math.max(...rank.values(), 1e-9)
  for (const [n, v] of rank) rank.set(n, Math.round((v / max) * 100))
  return rank
}

// ---------- 角色判定 ----------
function classifyRole(rel: string, ext: string, importedByCount: number, importCount: number): FileRole {
  const p = rel.toLowerCase()
  const name = basename(p)
  if (DOC_EXT.has(ext)) return 'doc'
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(p) || /(_test|\.test|\.spec|conftest)\./.test(name)) return 'test'
  if (/(^|\/)(examples?|samples?|cookbook)(\/|$)/.test(p)) return 'example'
  if (/\.(json|ya?ml|toml|ini|cfg|lock)$/.test(name) || /package\.json|pyproject\.toml|go\.mod|go\.sum|setup\.py/.test(name)) return 'config'
  if (/(^|\/)(main|__main__|app|run|cli|index|server)\.(py|go|js|ts|tsx)$/.test(name)) return 'entry'
  if (importedByCount === 0 && importCount >= 2) return 'entry' // 无人引用但引用很多 → 脚本入口
  return 'other'
}

// ---------- 构建/读取索引 ----------
export async function buildIndex(courseId: string): Promise<CourseIndex> {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')
  const root = course.root
  const head = gitHead(root)

  // 1. 文件清单
  const all: Array<{ path: string; ext: string; size: number }> = []
  const walk = (dir: string, depth: number) => {
    if (depth > 10) return
    let entries: any[]
    try { entries = readDirSafe(dir) } catch { return }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else {
        const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase()
        let size = 0
        try { size = statSafe(p) } catch {}
        all.push({ path: relativePath(root, p), ext, size })
      }
      if (all.length > 8000) return
    }
  }
  walk(root, 0)

  // 2. Python 符号（ast 批量）
  const pyFiles = all.filter(f => f.ext === '.py')
  const pyResult = pyFiles.length > 0 ? await extractPython(root) : new Map()

  // 3. 逐文件组装
  const files: IndexedFile[] = []
  const edges = new Map<string, string[]>()
  const goModule = readGoModuleName(root)
  const pathSet = new Set(all.map(f => f.path))

  for (const f of all) {
    const abs = resolve(root, f.path)
    let lang = 'other'
    if (f.ext === '.py') lang = 'python'
    else if (f.ext === '.go') lang = 'go'
    else if (['.js', '.jsx', '.mjs', '.cjs'].includes(f.ext)) lang = 'javascript'
    else if (['.ts', '.tsx'].includes(f.ext)) lang = 'typescript'
    else if (DOC_EXT.has(f.ext)) lang = 'doc'

    let lines = 0
    let symbols: FileSymbol[] = []
    let importsRaw: string[] = []

    if (lang === 'python') {
      const r = pyResult.get(f.path)
      if (r) { lines = r.lines; symbols = r.symbols; importsRaw = r.imports }
    } else if (lang !== 'doc' && f.size < 1024 * 1024) {
      try {
        let text = readFileSync(abs, 'utf8')
        if (text.includes('\uFFFD')) text = new TextDecoder('gbk').decode(readFileSync(abs))
        lines = text.split('\n').length
        if (lang === 'go') {
          const r = extractGo(f.path, text, goModule)
          symbols = r.symbols; importsRaw = r.imports
        } else {
          const r = extractJs(f.path, text)
          symbols = r.symbols; importsRaw = r.imports
        }
      } catch {}
    } else if (lang === 'doc') {
      try { lines = readFileSync(abs, 'utf8').split('\n').length } catch {}
    }

    symbols.sort((a, b) => a.line - b.line)
    // 类/大函数的 end 行修正：用下一个符号起点兜底
    for (let i = 0; i < symbols.length - 1; i++) {
      if (symbols[i].end <= symbols[i].line && symbols[i + 1].line > symbols[i].line) {
        symbols[i].end = symbols[i + 1].line - 1
      }
    }

    const file: IndexedFile = {
      path: f.path, lang, lines, size: f.size, symbols,
      imports: importsRaw.filter(i => pathSet.has(i)),
      importedBy: [], score: 0, role: 'other',
      readingMinutes: lines > 0 ? Math.max(1, Math.round(lines / 250)) : 0
    }
    files.push(file)
    edges.set(f.path, file.imports.slice())
  }

  // 4. 依赖图 + PageRank（仅代码文件参与）
  const codeFiles = files.filter(f => ['python', 'go', 'javascript', 'typescript'].includes(f.lang)).map(f => f.path)
  const codeSet = new Set(codeFiles)
  for (const [from, tos] of edges) {
    if (!codeSet.has(from)) continue
    edges.set(from, tos.filter(t => codeSet.has(t)))
  }
  const rank = pagerank(codeFiles, edges)
  const importedByCount = new Map<string, number>()
  for (const f of files) {
    for (const t of f.imports) {
      if (codeSet.has(t)) importedByCount.set(t, (importedByCount.get(t) || 0) + 1)
    }
  }
  // 综合评分：PageRank（引用中心度）+ 被引用数 + 规模/复杂度
  // 纯 PageRank 会低估「被少数文件引用但本身是主逻辑」的大文件（如 agents.py），
  // 规模因子把它拉回来（aider 面向 token 预算，我们面向阅读优先级，权重不同）
  const linesOf = new Map<string, number>()
  for (const f of files) linesOf.set(f.path, f.lines)
  const maxLines = Math.max(...codeFiles.map(p => linesOf.get(p) || 0), 1)
  for (const f of files) {
    if (!codeSet.has(f.path)) { f.score = 0; continue }
    const pr = rank.get(f.path) || 0
    const ref = Math.min(100, (importedByCount.get(f.path) || 0) * 14)
    const sizeScore = Math.min(100, Math.round(((linesOf.get(f.path) || 0) / maxLines) * 100))
    f.score = Math.min(100, Math.round(pr * 0.55 + ref * 0.25 + sizeScore * 0.20))
    f.importedBy = files.filter(x => x.imports.includes(f.path)).map(x => x.path)
    f.role = classifyRole(f.path, f.path.slice(f.path.lastIndexOf('.')), f.importedBy.length, f.imports.length)
    if (f.lang === 'doc') f.readingMinutes = Math.max(1, Math.round(f.lines / 400))
  }

  // 5. topCore / entries
  const roleOf = (p: string) => files.find(f => f.path === p)?.role
  const isBarrel = (p: string) => /(^|\/)__init__\.py$|(^|\/)index\.(ts|js)$/.test(p)
  const topCore = codeFiles
    .filter(p => (roleOf(p) === 'other' || roleOf(p) === 'core') && !isBarrel(p))
    .sort((a, b) => {
      const fa = files.find(x => x.path === a)!
      const fb = files.find(x => x.path === b)!
      return fb.score - fa.score
    })
    .slice(0, 8)
  for (const p of topCore) { const f = files.find(x => x.path === p); if (f) f.role = 'core' }

  const strongEntry = (p: string) => /(^|\/)(main|__main__|cli|app|run|serve|server|index)\.(py|go|js|ts|tsx)$/i.test(p)
  const depthOf = (p: string) => p.split('/').length
  const entries = files
    .filter(f => f.role === 'entry' && !isBarrel(f.path))
    .sort((a, b) => {
      const sa = (strongEntry(a.path) ? 0 : 1) * 100 + depthOf(a.path) * 2 - Math.min(10, a.imports.length)
      const sb = (strongEntry(b.path) ? 0 : 1) * 100 + depthOf(b.path) * 2 - Math.min(10, b.imports.length)
      return sa - sb
    })
    .slice(0, 2)
    .map(f => f.path)
  // 保底：入度 0 + 出度高且综合分高的也算入口
  if (entries.length === 0) {
    entries.push(...codeFiles
      .filter(p => (importedByCount.get(p) || 0) === 0)
      .sort((a, b) => {
        const fa = files.find(x => x.path === a)!
        const fb = files.find(x => x.path === b)!
        return fb.score - fa.score
      })
      .slice(0, 3))
  }

  const index: CourseIndex = {
    courseId,
    head,
    generatedAt: Date.now(),
    algoVersion: ALGO_VERSION,
    files,
    stats: {
      total: files.length,
      code: codeFiles.length,
      docs: files.filter(f => f.role === 'doc').length,
      tests: files.filter(f => f.role === 'test').length,
      examples: files.filter(f => f.role === 'example').length,
      pythonOk: pyFiles.length === 0 || pyResult.size > 0
    },
    topCore,
    entries
  }

  try { writeFileSync(indexDir(courseId), JSON.stringify(index)) } catch {}
  return index
}

export function getIndex(courseId: string, opts: { buildIfMissing?: boolean } = {}): CourseIndex | null {
  const p = indexDir(courseId)
  if (existsSync(p)) {
    try {
      const idx: CourseIndex = JSON.parse(readFileSync(p, 'utf8'))
      const course = getCourseById(courseId)
      idx.stale = idx.algoVersion !== ALGO_VERSION
      if (!idx.stale && course) {
        const head = gitHead(course.root)
        idx.stale = head !== idx.head
      }
      return idx
    } catch { return null }
  }
  return null
}

export function isIndexStale(courseId: string): boolean {
  const idx = getIndex(courseId)
  return !idx || idx.stale === true
}

// ---------- 工具 ----------
function readDirSafe(dir: string): any[] {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return [] }
}
function statSafe(p: string): number {
  return statSync(p).size
}
function relativePath(root: string, p: string): string {
  const rel = resolve(p).slice(resolve(root).length + 1)
  return rel.replace(/\\/g, '/')
}
