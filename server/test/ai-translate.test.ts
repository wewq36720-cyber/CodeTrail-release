// CodeTrail 教程翻译 · 单元测试（B-06）
// 运行：cd app/server && node --import tsx --test test/ai-translate.test.ts
// 隔离：本文件进程内使用独立临时 LEARNDESK_DIR，绝不触碰用户真实 .learndesk；
//       预置空 db.sqlite 可阻断 db/index.ts 对旧 LDD 的一次性迁移拷贝。
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let ldd = ''
let db: typeof import('../src/db/index.ts')
let settings: typeof import('../src/settings.ts')
let ai: typeof import('../src/ai.ts')

const NO_KEY_ERROR = 'AI 未配置：请到设置页填写 API Key'
const COURSE_NOT_FOUND = '课程不存在'

// fetch 调用记录：每个用例独立收集（url / 请求头 / 序列化后的请求体）
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []

function stubFetch(handler: (url: string, init?: RequestInit) => any) {
  globalThis.fetch = (async (url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }) as unknown as typeof fetch
}

function fakeOkResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => '', json: async () => body } as unknown as Response
}

function lastCall() {
  assert.equal(fetchCalls.length, 1, '应恰好发出一次 provider 请求')
  return fetchCalls[0]
}

// 直接写 settings.json 并重载缓存（saveSettings 对空 apiKey 有“保留原 Key”语义，清 Key 需走文件）
function setAi(aiPatch: Record<string, unknown>) {
  const merged = { baseURL: 'http://fake.local', ...aiPatch }
  writeFileSync(join(ldd, 'settings.json'), JSON.stringify({ ai: merged }))
  settings.initSettings()
}

function insertCourse(id: string) {
  db.run(
    'INSERT INTO courses (id, kind, root, slug, lang, label, tags, scan_meta, missing, last_scan_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
    [id, 'repo', ldd, id.replace('repo:', ''), 'py', '测试课程', '[]', '{"fileCount":1}', Date.now()]
  )
}

before(async () => {
  ldd = mkdtempSync(join(tmpdir(), 'codetrail-translate-unit-'))
  process.env.LEARNDESK_DIR = ldd
  // 阻断 db/index.ts 的旧 LDD 一次性迁移（有真实 app/server/.learndesk 时会把真实数据拷进临时目录）
  writeFileSync(join(ldd, 'db.sqlite'), '')
  db = await import('../src/db/index.ts')
  settings = await import('../src/settings.ts')
  ai = await import('../src/ai.ts')
  await db.initDatabase()
  settings.initSettings()
})

after(() => {
  try { db.closeDatabase() } catch {}
  rmSync(ldd, { recursive: true, force: true })
})

beforeEach(() => {
  fetchCalls = []
  // 默认无 Key；需要 provider 的用例各自安装响应桩
  setAi({ provider: 'openai', apiKey: '', model: 'gpt-test' })
})

afterEach(() => {
  // 清掉课程表，避免用例间串扰
  if (db && db !== undefined) {
    try { db.runExec('DELETE FROM courses') } catch {}
  }
})

// ---------- parseTranslateRequest：同步边界 ----------
test('text 非字符串或为空 → 边界错误（不调用 provider）', () => {
  for (const bad of [undefined, null, 123, {}, [], '', '   \n  ']) {
    assert.throws(() => ai.parseTranslateRequest({ text: bad }), /text 必须是非空字符串/)
    assert.equal(fetchCalls.length, 0)
  }
  assert.throws(() => ai.parseTranslateRequest('not-an-object'), /请求体必须是 JSON 对象/)
})

test('targetLang 缺省 → 解析为 zh', () => {
  const req = ai.parseTranslateRequest({ text: 'Hello world' })
  assert.equal(req.text, 'Hello world')
  assert.equal(req.targetLang, 'zh')
  assert.equal(req.courseId, undefined)
  assert.equal(fetchCalls.length, 0)
})

test('targetLang 非 zh → 边界错误（不调用 provider）', () => {
  for (const bad of ['en', 'ZH', '', 123, null]) {
    assert.throws(() => ai.parseTranslateRequest({ text: 'hi', targetLang: bad }), /targetLang 目前仅支持 'zh'/)
    assert.equal(fetchCalls.length, 0)
  }
})

test('courseId 可选：缺省为 undefined，提供时必须是非空字符串', () => {
  assert.equal(ai.parseTranslateRequest({ text: 'hi' }).courseId, undefined)
  assert.equal(ai.parseTranslateRequest({ text: 'hi', courseId: 'repo:x' }).courseId, 'repo:x')
  for (const bad of ['', '   ', 42, null]) {
    assert.throws(() => ai.parseTranslateRequest({ text: 'hi', courseId: bad }), /courseId 必须是非空字符串/)
  }
})

test('输入超过 6000-token 估算 → 边界错误，原文不被静默截断', () => {
  const tooLong = 'a'.repeat(21001) // ceil(21001/3.5) = 6001 > 6000
  assert.throws(() => ai.parseTranslateRequest({ text: tooLong }), /text 过长/)
  const boundary = 'a'.repeat(20999) // ceil(20999/3.5) = 6000，恰好允许
  assert.equal(ai.parseTranslateRequest({ text: boundary }).text.length, 20999)
})

test('text 原样保留（含首尾空白与换行，不 trim）', () => {
  const raw = '  ## Getting started\n\nInstall it.  \n'
  assert.equal(ai.parseTranslateRequest({ text: raw }).text, raw)
})

// ---------- aiTranslate：无 Key / 课程 / provider 映射 ----------
test('无 API Key → 返回现有错误形状，provider 调用次数为 0', async () => {
  const result = await ai.aiTranslate({ text: 'hello', targetLang: 'zh' })
  assert.deepEqual(result, { content: '', error: NO_KEY_ERROR })
  assert.equal(fetchCalls.length, 0)
})

test('有效 courseId → 只校验课程存在，请求不携带课程文件上下文', async () => {
  insertCourse('repo:ok-course')
  stubFetch((url, init) => fakeOkResponse({ choices: [{ message: { content: '中文译文' } }] }))
  setAi({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' })

  const result = await ai.aiTranslate({ text: '## Getting started\n\nRead README.md.', targetLang: 'zh', courseId: 'repo:ok-course' })
  assert.equal(result.content, '中文译文')

  const call = lastCall()
  assert.equal(call.url, 'http://fake.local/chat/completions')
  const body = JSON.parse(String(call.init?.body))
  assert.equal(body.messages[1].role, 'user')
  // user 层只包含 text 与数据分隔符：精确匹配，证明未注入 README/文件全文/课程上下文
  assert.equal(body.messages[1].content, '---- 待翻译内容开始 ----\n## Getting started\n\nRead README.md.\n---- 待翻译内容结束 ----')
  // 请求整体不出现 LDD 路径
  assert.ok(!JSON.stringify(call).includes(ldd), '请求不得出现 LDD 路径')
})

test('不存在 courseId → 课程错误形状，不调用 provider', async () => {
  setAi({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' })
  const result = await ai.aiTranslate({ text: 'hello', targetLang: 'zh', courseId: 'repo:nope' })
  assert.deepEqual(result, { content: '', error: COURSE_NOT_FOUND })
  assert.equal(fetchCalls.length, 0)
})

test('OpenAI 兼容响应 → 只取 choices[0].message.content，认证头与路径正确', async () => {
  stubFetch((url, init) => {
    return fakeOkResponse({ choices: [{ message: { content: '只取第一条' } }] })
  })
  setAi({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' })

  const result = await ai.aiTranslate({ text: 'translate me', targetLang: 'zh' })
  assert.equal(result.content, '只取第一条')

  const call = lastCall()
  assert.equal(call.url, 'http://fake.local/chat/completions')
  assert.equal((call.init?.headers as any)?.Authorization, 'Bearer sk-test')
  const body = JSON.parse(String(call.init?.body))
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
})

test('Anthropic 响应 → 拼接 content blocks 文本，认证头与路径正确', async () => {
  stubFetch((url, init) => {
    return fakeOkResponse({ content: [{ type: 'text', text: '译文A' }, { type: 'text', text: '译文B' }] })
  })
  setAi({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-test' })

  const result = await ai.aiTranslate({ text: 'translate me', targetLang: 'zh' })
  assert.equal(result.content, '译文A译文B')

  const call = lastCall()
  assert.equal(call.url, 'http://fake.local/v1/messages')
  assert.equal((call.init?.headers as any)?.['x-api-key'], 'sk-test')
  assert.equal((call.init?.headers as any)?.['anthropic-version'], '2023-06-01')
  const body = JSON.parse(String(call.init?.body))
  assert.ok(typeof body.system === 'string' && body.system.length > 0)
  assert.equal(body.messages[0].role, 'user')
})

test('provider 非 2xx → 错误形状沿用既有前缀，不泄漏 API Key', async () => {
  stubFetch(() => ({ ok: false, status: 429, text: async () => 'rate limited', json: async () => ({}) }) as unknown as Response)
  setAi({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' })

  const result = await ai.aiTranslate({ text: 'translate me', targetLang: 'zh' })
  assert.equal(result.content, '')
  assert.match(result.error || '', /^API 错误: 429/)
  assert.ok(!(result.error || '').includes('sk-test'))
})

test('网络异常 → 错误形状，不把 provider 错误当成功译文', async () => {
  stubFetch(() => { throw new Error('ECONNREFUSED 127.0.0.1:9') })
  setAi({ provider: 'anthropic', apiKey: 'sk-test', model: 'claude-test' })

  const result = await ai.aiTranslate({ text: 'translate me', targetLang: 'zh' })
  assert.deepEqual(result, { content: '', error: '请求失败: ECONNREFUSED 127.0.0.1:9' })
})

test('空响应 → 错误形状', async () => {
  stubFetch(() => fakeOkResponse({ choices: [{ message: { content: null } }] }))
  setAi({ provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' })

  const result = await ai.aiTranslate({ text: 'translate me', targetLang: 'zh' })
  assert.deepEqual(result, { content: '', error: '空响应' })
})