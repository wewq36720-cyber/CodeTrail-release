// CodeTrail 教程翻译 · HTTP 集成测试（B-06 §7.2）
// 运行：cd app/server && node --import tsx --test test/ai-translate.http.test.ts
// 方式：导入真实 Express app（index.ts 仅主模块自启动，测试导入不监听 8787），挂到随机端口；
//       本地一次性 fake provider 承担 /chat/completions 与 /v1/messages，全部请求在真实 HTTP 边界验证。
// 隔离：独立临时 LEARNDESK_DIR；预置空 db.sqlite 阻断旧 LDD 一次性迁移；绝不触碰用户真实 .learndesk。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ldd = ''
let fake: ReturnType<typeof createServer>
let fakePort = 0
let seen: Array<{ url: string; headers: Record<string, any>; body: string }> = []
let app: any
let server: any
let base = ''
let db: typeof import('../src/db/index.ts')
let settings: typeof import('../src/settings.ts')

const NO_KEY_ERROR = 'AI 未配置：请到设置页填写 API Key'
const COURSE_NOT_FOUND = '课程不存在'
const API_KEY = 'sk-http-test-1'

function setAi(aiPatch: Record<string, unknown>) {
  writeFileSync(join(ldd, 'settings.json'), JSON.stringify({ ai: { baseURL: `http://127.0.0.1:${fakePort}`, ...aiPatch } }))
  settings.initSettings()
}

async function post(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

function lastSeen() {
  assert.ok(seen.length > 0, 'fake provider 应收到请求')
  return seen[seen.length - 1]
}

before(async () => {
  ldd = mkdtempSync(join(tmpdir(), 'codetrail-translate-http-'))
  process.env.LEARNDESK_DIR = ldd
  writeFileSync(join(ldd, 'db.sqlite'), '')

  fake = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const headers: Record<string, any> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v
      seen.push({ url: req.url || '', headers, body: raw })
      if (raw.includes('FAIL502')) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'upstream down' }))
        return
      }
      const path = req.url || ''
      if (path.endsWith('/chat/completions')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '中文译文（OpenAI）' } }] }))
      } else if (path.endsWith('/v1/messages')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ content: [{ type: 'text', text: '译文A' }, { type: 'text', text: '译文B' }] }))
      } else {
        res.statusCode = 500
        res.end('{}')
      }
    })
  })
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', () => r()))
  fakePort = (fake.address() as any).port

  db = await import('../src/db/index.ts')
  settings = await import('../src/settings.ts')
  const { app: realApp } = await import('../src/index.ts')
  app = realApp
  await db.initDatabase()
  settings.initSettings()

  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', () => r()))
  base = `http://127.0.0.1:${server.address().port}/api`
})

after(async () => {
  server?.close()
  fake?.close()
  try { db?.closeDatabase() } catch {}
  rmSync(ldd, { recursive: true, force: true })
})

test('路由真实注册于 /api/ai/translate，OpenAI 适配经真实 HTTP 得到 content', async () => {
  const seenBefore = seen.length
  setAi({ provider: 'openai', apiKey: API_KEY, model: 'gpt-test' })

  const res = await post('/ai/translate', { text: '## Getting started\n\nInstall the package.', targetLang: 'zh' })
  assert.equal(res.status, 200)
  assert.equal(res.data.content, '中文译文（OpenAI）')

  const req = lastSeen()
  assert.ok(seen.length === seenBefore + 1, '恰好一次 provider 请求')
  assert.equal(req.url, '/chat/completions')
  const body = JSON.parse(req.body)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
  assert.ok(body.messages[1].content.includes('---- 待翻译内容开始 ----'))
  assert.ok(body.messages[1].content.includes('Install the package.'))
  // 请求不含 LDD 写入路径与 API Key；响应也不回传 Key
  assert.ok(!req.body.includes(ldd), 'provider 请求不得含 LDD 路径')
  assert.ok(!req.body.includes(API_KEY), 'provider 请求体不得含 API Key')
  assert.ok(!JSON.stringify(res.data).includes(API_KEY), '响应不得含 API Key')
})

test('Anthropic 适配经真实 HTTP：拼接 content blocks，认证头与路径正确', async () => {
  setAi({ provider: 'anthropic', apiKey: API_KEY, model: 'claude-test' })

  const res = await post('/ai/translate', { text: 'Hello world' })
  assert.equal(res.status, 200)
  assert.equal(res.data.content, '译文A译文B')

  const req = lastSeen()
  assert.equal(req.url, '/v1/messages')
  assert.equal(req.headers['x-api-key'], API_KEY)
  assert.equal(req.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(req.body)
  assert.ok(typeof body.system === 'string' && body.system.length > 0, 'Anthropic 走 system 字段')
  assert.equal(body.messages[0].role, 'user')
  assert.ok(!req.body.includes(ldd), 'provider 请求不得含 LDD 路径')
})

test('400 输入错误：缺 text / 空 text / targetLang 非法 / 非对象请求体', async () => {
  setAi({ provider: 'openai', apiKey: API_KEY, model: 'gpt-test' })
  const seenBefore = seen.length
  const cases: Array<[unknown, RegExp]> = [
    [{}, /text 必须是非空字符串/],
    [{ text: '   ' }, /text 必须是非空字符串/],
    [{ text: 123 }, /text 必须是非空字符串/],
    [{ text: 'hi', targetLang: 'en' }, /targetLang 目前仅支持 'zh'/],
    [{ text: 'hi', courseId: '' }, /courseId 必须是非空字符串/],
    // 非对象 JSON 由 express.json 严格模式在 wrap 之前以 400 拒绝（与既有路由一致），这里只断言状态码
    ['not-an-object', /__STATUS_ONLY__/]
  ]
  for (const [payload, re] of cases) {
    const res = await post('/ai/translate', payload as any)
    assert.equal(res.status, 400, `payload=${JSON.stringify(payload)} 应为 400`)
    if (re.source !== '__STATUS_ONLY__') {
      assert.match(String(res.data?.error || ''), re)
    }
  }
  assert.equal(seen.length, seenBefore, '400 路径不得触达 provider')
  // 超限（>6000 tokens）同样是 400
  const res = await post('/ai/translate', { text: 'x'.repeat(22000) })
  assert.equal(res.status, 400)
  assert.match(String(res.data?.error || ''), /text 过长/)
  assert.equal(seen.length, seenBefore, '超限 400 不得触达 provider')
})

test('无 Key → 200 业务错误形状，不出网', async () => {
  const seenBefore = seen.length
  setAi({ provider: 'openai', apiKey: '', model: 'gpt-test' })
  const res = await post('/ai/translate', { text: 'hello' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.data, { content: '', error: NO_KEY_ERROR })
  assert.equal(seen.length, seenBefore, '未配置 Key 不得发起 provider 请求')
})

test('不存在 courseId → 200 业务错误形状，不出网', async () => {
  const seenBefore = seen.length
  setAi({ provider: 'openai', apiKey: API_KEY, model: 'gpt-test' })
  const res = await post('/ai/translate', { text: 'hello', courseId: 'repo:nope' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.data, { content: '', error: COURSE_NOT_FOUND })
  assert.equal(seen.length, seenBefore, '课程不存在不得发起 provider 请求')
})

test('存在 courseId → 200，请求不携带课程文件上下文', async () => {
  db.run(
    'INSERT INTO courses (id, kind, root, slug, lang, label, tags, scan_meta, missing, last_scan_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
    ['repo:ok-course', 'repo', ldd, 'ok-course', 'py', '测试课程', '[]', '{"fileCount":1}', Date.now()]
  )
  setAi({ provider: 'openai', apiKey: API_KEY, model: 'gpt-test' })

  const res = await post('/ai/translate', { text: 'translate this paragraph', courseId: 'repo:ok-course' })
  assert.equal(res.status, 200)
  assert.equal(res.data.content, '中文译文（OpenAI）')

  const req = lastSeen()
  const body = JSON.parse(req.body)
  assert.equal(body.messages[1].content, '---- 待翻译内容开始 ----\ntranslate this paragraph\n---- 待翻译内容结束 ----')
  assert.ok(!req.body.includes(ldd), 'provider 请求不得含 LDD 路径')
})

test('provider 非 2xx → 200 错误形状，沿用 callAi 既有前缀', async () => {
  setAi({ provider: 'openai', apiKey: API_KEY, model: 'gpt-test' })
  const res = await post('/ai/translate', { text: 'FAIL502 please' })
  assert.equal(res.status, 200)
  assert.equal(res.data.content, '')
  assert.match(String(res.data.error || ''), /^API 错误: 502/)
  assert.ok(!String(res.data.error).includes(API_KEY))
})

test('500 未预期异步异常：wrap() 异步分支经真实路由返回 500', async () => {
  // 关闭数据库使 getCourseById 在异步 aiTranslate 内抛出 → wrap 的 Promise.reject 分支 → 500
  setAi({ provider: 'openai', apiKey: API_KEY, model: 'gpt-test' })
  db.closeDatabase()
  try {
    const res = await post('/ai/translate', { text: 'boom', courseId: 'repo:any' })
    assert.equal(res.status, 500)
    assert.ok(typeof res.data?.error === 'string' && res.data.error.length > 0)
  } finally {
    await db.initDatabase()
  }
})