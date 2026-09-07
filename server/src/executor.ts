import { spawn, spawnSync } from 'child_process'
import { getCourseById } from './scanner.js'
import { getLddPath } from './db/index.js'
import { join, resolve } from 'path'
import { writeFileSync, mkdirSync, existsSync, readFileSync, copyFileSync, rmSync, readdirSync } from 'fs'
import { randomUUID } from 'crypto'

const LDD = getLddPath()
const TMP_DIR = join(LDD, 'tmp')
mkdirSync(TMP_DIR, { recursive: true })

export interface LangProfile {
  check: string[]        // argv 模板，{file} 占位
  run: string[]
  available: boolean
  installHint?: string
}

// 语言档案（04 §4.4）。go 由启动探测置位（FR-18）
export const LANG_PROFILES: Record<string, LangProfile> = {
  python: { check: ['uv', 'run', 'python', '-B', '-m', 'py_compile', '{file}'], run: ['uv', 'run', 'python', '{file}'], available: true },
  javascript: { check: ['node', '--check', '{file}'], run: ['node', '{file}'], available: true },
  typescript: { check: ['node', '--check', '{file}'], run: ['node', '{file}'], available: true },
  go: { check: ['go', 'vet', '{file}'], run: ['go', 'run', '{file}'], available: false, installHint: '未检测到 Go 工具链 → 安装：winget install GoLang.Go 或 https://go.dev/dl/' }
}

/** 启动探测一次，写回档案可用性（FR-18） */
export function probeToolchains() {
  const probes: Record<string, string> = { python: 'uv', javascript: 'node', typescript: 'node', go: 'go' }
  for (const [lang, bin] of Object.entries(probes)) {
    const profile = LANG_PROFILES[lang]
    if (!profile) continue
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      profile.available = r.status === 0
    } catch {
      profile.available = false
    }
  }
}

function detectLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (ext === 'py') return 'python'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'go') return 'go'
  return 'unknown'
}

// 输出解码：UTF-8 优先，检测替代符则回退 GBK（Node 内置 ICU 支持 gbk，NF-04）
function decodeOutput(buffer: Buffer): string {
  const text = buffer.toString('utf8')
  if (text.includes('\uFFFD')) {
    try { return new TextDecoder('gbk').decode(buffer) } catch { return text }
  }
  return text
}

function resolveTemplate(template: string[], file: string): string[] {
  return template.map(part => part.replace('{file}', file))
}

// 沙箱环境（NF-02 / 仓库只读）：字节码与产物全部重定向到 LDD/tmp
function sandboxEnv(runDir: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: join(runDir, 'pycache'),
    ...extra
  }
}

export function staticCheck(body: { courseId: string; path: string }): { kind: 'static'; ok: boolean; items: any[]; ms: number; lang?: string; unavailable?: boolean } {
  const course = getCourseById(body.courseId)
  if (!course) throw new Error('Course not found')

  const fullPath = resolve(course.root, body.path)
  if (!fullPath.toLowerCase().startsWith(resolve(course.root).toLowerCase())) throw new Error('Path traversal denied')

  const lang = detectLang(body.path)
  const profile = LANG_PROFILES[lang]
  if (lang === 'unknown' || !profile) {
    return { kind: 'static', ok: false, lang, items: [{ line: 0, msg: `暂不支持 ${lang || '未知'} 文件的静态检查`, src: '' }], ms: 0 }
  }
  if (!profile.available) {
    return { kind: 'static', ok: false, lang, unavailable: true, items: [{ line: 0, msg: profile.installHint || `${lang} 运行时不可用`, src: '' }], ms: 0 }
  }

  const start = Date.now()
  const runDir = join(TMP_DIR, 'check-' + randomUUID().slice(0, 8))
  mkdirSync(runDir, { recursive: true })
  try {
    const argv = resolveTemplate(profile.check, fullPath)
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: runDir,
      timeout: 30000,
      windowsHide: true,
      env: sandboxEnv(runDir)
    })
    const ms = Date.now() - start

    if (result.status === 0) {
      return { kind: 'static', ok: true, lang, items: [], ms }
    }

    const output = decodeOutput(Buffer.concat([
      Buffer.from(result.stdout || ''),
      Buffer.from(result.stderr || '')
    ]))
    return { kind: 'static', ok: false, lang, items: parseCheckErrors(output, lang), ms }
  } catch (e: any) {
    return { kind: 'static', ok: false, lang, items: [{ line: 0, msg: e.message, src: '' }], ms: Date.now() - start }
  } finally {
    try { rmSync(runDir, { recursive: true, force: true }) } catch {}
  }
}

// 解析不同工具的错误行号：
// python: `File "x.py", line 12` / `x.py:12: ...`；node: `x.js:12`; go: `x.go:12:5: msg`
function parseCheckErrors(output: string, lang: string): any[] {
  const items: any[] = []
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (lang === 'python') {
      const pyFile = line.match(/File\s+"(.+?)",\s*line\s+(\d+)/)
      if (pyFile) {
        items.push({ line: parseInt(pyFile[2]), msg: line, src: '' })
        continue
      }
    }
    const generic = line.match(/(.+?):(\d+)(?::(\d+))?:\s*(.*)/)
    if (generic) {
      items.push({ line: parseInt(generic[2]), msg: generic[4] || line, src: '' })
      continue
    }
    if (!/^Traceback|^SyntaxError|^Error/i.test(line)) {
      items.push({ line: 0, msg: line, src: '' })
    }
  }
  // Traceback 的 SyntaxError 详情行补充
  const synMatch = output.match(/\("([^"]+)"\)/)
  if (synMatch && items.length && !items[0].msg.includes('SyntaxError')) {
    items[0].msg += ` (${synMatch[1]})`
  }
  return items.slice(0, 50)
}

export interface TestDef {
  model: 'm1' | 'm2'
  cmdLang?: string
  stdin?: string
  expect?: { stdoutInclude?: string; stdoutExact?: string; exitOk?: boolean }
  entry?: string
  runtime?: string
}

export function runTest(body: { courseId: string; path: string; testDef: TestDef }, broadcastFn: (msg: any) => void) {
  let course: any
  try {
    course = getCourseById(body.courseId)
  } catch (e: any) {
    broadcastFn({ type: 'done', verdict: { ok: false, error: e.message } })
    return
  }
  if (!course) {
    broadcastFn({ type: 'done', verdict: { ok: false, error: 'Course not found' } })
    return
  }

  const fullPath = resolve(course.root, body.path)
  if (!fullPath.toLowerCase().startsWith(resolve(course.root).toLowerCase())) {
    broadcastFn({ type: 'done', verdict: { ok: false, error: 'Path traversal denied' } })
    return
  }

  const runId = randomUUID()
  const runDir = join(TMP_DIR, runId)
  mkdirSync(runDir, { recursive: true })

  const testDef = body.testDef
  const lang = testDef.cmdLang || detectLang(body.path)

  const finish = (verdict: any) => {
    broadcastFn({ type: 'done', verdict })
    // 结果目录保留供排查，由下次清理：tmp 只保留最近 20 个运行目录
    pruneTmp()
  }

  if (testDef.model === 'm1') {
    runM1Test(runDir, course.root, fullPath, lang, testDef, broadcastFn, finish)
  } else {
    runM2Test(runDir, course.root, fullPath, lang, testDef, broadcastFn, finish)
  }
}

function pruneTmp() {
  try {
    const dirs = readdirSafe(TMP_DIR).sort()
    while (dirs.length > 20) {
      const oldest = dirs.shift()!
      try { rmSync(join(TMP_DIR, oldest), { recursive: true, force: true }) } catch {}
    }
  } catch {}
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}

function withTimeoutGuard(
  child: any,
  broadcastFn: (msg: any) => void,
  finish: (v: any) => void,
  onStd: (stream: 'stdout' | 'stderr', text: string) => void
) {
  let stdout = ''
  let stderr = ''
  let settled = false

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = decodeOutput(chunk)
    stdout = (stdout + text).slice(-400000)
    if (stdout.length > 200000) child.kill()
    onStd('stdout', text)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = decodeOutput(chunk)
    stderr = (stderr + text).slice(-400000)
    if (stderr.length > 200000) child.kill()
    onStd('stderr', text)
  })

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    try { child.kill('SIGKILL') } catch {}
    broadcastFn({ type: 'exec', stream: 'stderr', chunk: '\n[执行超时 30s，已终止]\n' })
    finish({ ok: false, error: '执行超时（30s 上限）', stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) })
  }, 30000)

  child.on('error', (err: Error) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    finish({ ok: false, error: `无法启动进程: ${err.message}（检查运行时是否可用）` })
  })

  child.on('close', (code: number | null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    finish({ ok: code === 0, exitCode: code, stdout, stderr, timedOut: false })
  })

  return { getStdout: () => stdout, getStderr: () => stderr }
}

function runM1Test(
  runDir: string, courseRoot: string, targetFile: string, lang: string,
  testDef: TestDef, broadcastFn: (msg: any) => void, finish: (v: any) => void
) {
  const profile = LANG_PROFILES[lang]
  if (!profile || !profile.available) {
    finish({ ok: false, error: profile?.installHint || `语言 ${lang} 不可用` })
    return
  }

  if (testDef.stdin) {
    writeFileSync(join(runDir, 'input.txt'), testDef.stdin)
  }

  const argv = resolveTemplate(profile.run, targetFile)
  const child = spawn(argv[0], argv.slice(1), {
    cwd: runDir,                       // 不在仓库目录里跑（防写入）
    windowsHide: true,
    env: sandboxEnv(runDir)
  })

  withTimeoutGuard(child, broadcastFn, (verdict) => {
    if (!verdict.ok && !verdict.error) {
      // FR-17：失败给期望 vs 实际 diff（上下文 3 行）
      const detail = diffVerdict(testDef, verdict.stdout || '', verdict.exitCode)
      finish({ ...verdict, ...detail })
      return
    }
    finish(verdict)
  }, (stream, text) => broadcastFn({ type: 'exec', stream, chunk: text }))
}

function diffVerdict(testDef: TestDef, stdout: string, exitCode: number | null): { ok: boolean; reason?: string; diff?: string } {
  const reasons: string[] = []
  const expect = testDef.expect || {}
  if (expect.exitOk !== false && exitCode !== 0) reasons.push(`退出码 ${exitCode} ≠ 0`)
  if (expect.stdoutExact && stdout.trim() !== expect.stdoutExact.trim()) reasons.push('输出不等于期望')
  if (expect.stdoutInclude && !stdout.includes(expect.stdoutInclude)) reasons.push(`输出不包含「${expect.stdoutInclude}」`)
  if (reasons.length === 0) return { ok: true }

  let diff = ''
  if (expect.stdoutExact) {
    diff = [
      '--- 期望 ---', ...expect.stdoutExact.trim().split('\n').slice(0, 10),
      '--- 实际 ---', ...stdout.trim().split('\n').slice(0, 10)
    ].join('\n')
  } else if (expect.stdoutInclude) {
    const idx = stdout.indexOf(expect.stdoutInclude)
    const ctx = idx === -1 ? stdout : stdout
    diff = `实际输出（前 10 行）:\n${ctx.split('\n').slice(0, 10).join('\n')}`
  }
  return { ok: false, reason: reasons.join('；'), diff }
}

function runM2Test(
  runDir: string, courseRoot: string, targetFile: string, lang: string,
  testDef: TestDef, broadcastFn: (msg: any) => void, finish: (v: any) => void
) {
  const profile = LANG_PROFILES[lang]
  if (!profile || !profile.available) {
    finish({ ok: false, error: profile?.installHint || `语言 ${lang} 不可用` })
    return
  }
  if (!testDef.entry) {
    finish({ ok: false, error: 'M2 需要 entry 字段指定断言脚本' })
    return
  }

  const testFile = resolve(courseRoot, testDef.entry)
  if (!testFile.toLowerCase().startsWith(resolve(courseRoot).toLowerCase())) {
    finish({ ok: false, error: '测试脚本必须位于课程目录内' })
    return
  }
  if (!existsSync(testFile)) {
    finish({ ok: false, error: `断言脚本不存在: ${testDef.entry}` })
    return
  }
  if (!existsSync(targetFile)) {
    finish({ ok: false, error: `被测文件不存在: ${body0(testDef, targetFile)}` })
    return
  }

  // 被测文件副本 + 断言脚本同放 runDir（04 §4.4）
  copyFileSync(targetFile, join(runDir, targetFile.split(/[\\/]/).pop()!))
  copyFileSync(testFile, join(runDir, testFile.split(/[\\/]/).pop()!))
  const entryName = testFile.split(/[\\/]/).pop()!

  const env = lang === 'python'
    ? sandboxEnv(runDir, { PYTHONPATH: [runDir, courseRoot].join(';') })
    : sandboxEnv(runDir, { NODE_PATH: [runDir, courseRoot].join(';') })

  const argv = lang === 'python' ? ['uv', 'run', 'python', entryName] : ['node', entryName]
  const child = spawn(argv[0], argv.slice(1), { cwd: runDir, windowsHide: true, env })

  withTimeoutGuard(child, broadcastFn, (verdict) => {
    // python unittest 输出 OK 也可能退出码非 0 的情况兜底：输出含 "OK" 且非 FAILED
    if (!verdict.ok && lang === 'python' && /\bOK\b/.test(verdict.stdout || '') && !/FAILED/i.test(verdict.stdout || '')) {
      verdict.ok = true
    }
    finish(verdict)
  }, (stream, text) => broadcastFn({ type: 'exec', stream, chunk: text }))
}

function body0(_t: TestDef, targetFile: string) {
  return targetFile.split(/[\\/]/).pop() || targetFile
}

// FR-15 P1：对整条路线的文件做批量静态检查（上限 20 个，串行执行）
export function staticCheckBatch(body: { courseId: string; paths: string[] }): Array<{ path: string; ok: boolean; issues: number; unavailable?: boolean }> {
  const paths = (body.paths || []).slice(0, 20)
  return paths.map(p => {
    try {
      const r = staticCheck({ courseId: body.courseId, path: p })
      return { path: p, ok: r.ok, issues: r.items.length, unavailable: r.unavailable }
    } catch (e: any) {
      return { path: p, ok: false, issues: 1, unavailable: false, error: e.message }
    }
  })
}

export function validateTest(body: { testDef: TestDef }): { ok: boolean; error?: string } {
  const td = body.testDef
  if (td.model === 'm1') {
    if (!td.expect || (!td.expect.stdoutInclude && !td.expect.stdoutExact && td.expect.exitOk === undefined)) {
      return { ok: false, error: 'M1 需要 expect 字段（stdoutInclude / stdoutExact / exitOk 至少其一）' }
    }
    return { ok: true }
  }
  if (td.model === 'm2') {
    if (!td.entry) return { ok: false, error: 'M2 需要 entry 字段指定断言脚本' }
    return { ok: true }
  }
  return { ok: false, error: '未知测试模型' }
}

export function readTestDefs(courseId: string, relPath: string): any {
  // 测试定义存 LDD/tests/<course>/<相对路径>.json（FR-16）
  const p = join(LDD, 'tests', courseId.replace(/[\\/:*?"<>|]/g, '_'), relPath.replace(/[\\/]/g, '__') + '.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

export function saveTestDefs(courseId: string, relPath: string, def: any): { saved: string } {
  const dir = join(LDD, 'tests', courseId.replace(/[\\/:*?"<>|]/g, '_'))
  mkdirSync(dir, { recursive: true })
  const p = join(dir, relPath.replace(/[\\/]/g, '__') + '.json')
  writeFileSync(p, JSON.stringify(def, null, 2))
  return { saved: p }
}
