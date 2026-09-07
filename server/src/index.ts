import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname } from 'path'
import { initDatabase } from './db/index.js'
import { initSettings, getSettings, saveSettings, getSettingsMasked } from './settings.js'
import { scanRoots, getCourses, getCourseById, updateCourseTags } from './scanner.js'
import { getFileTree, getFileContent, getFileHead, getBookmarks, setBookmarks, getDirectory, searchCourseFiles, getFlatFiles } from './fileService.js'
import { getRoutes, saveRoute, deleteRoute, duplicateRoute, setDefaultRoute, importMdRoute, generateAiRouteDraft, getRouteTemplates } from './routes.js'
import { getProgress, updateStepProgress, autoCompleteTestStep } from './progress.js'
import { getNotes, saveNote, deleteNote, searchNotes } from './notes.js'
import { getActivities, getDashboard } from './dashboard.js'
import { staticCheck, staticCheckBatch, runTest, validateTest, probeToolchains, LANG_PROFILES, readTestDefs, saveTestDefs } from './executor.js'
import { getIndex, buildIndex } from './indexer.js'
import type { SortKey } from './fileService.js'
import { getPreviewToken, servePreview } from './preview.js'
import { exportBackup, importBackup, listBackups } from './backup.js'
import { aiExplain, aiChat, aiGenerateRoute, aiTestConnection, aiTranslate, parseTranslateRequest, aiTranslateBatch, parseTranslateBatchRequest } from './ai.js'
import { resolveFsPath } from './paths.js'
import { setupWebSocket, broadcast } from './ws.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
setupWebSocket(wss)

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'
const CLIENT_URL = 'http://127.0.0.1:5173'

app.use(cors({ origin: CLIENT_URL }))
app.use(express.json({ limit: '10mb' }))

type Handler = (req: any, res: any) => any
const wrap = (fn: Handler): Handler => (req: any, res: any) => {
  try {
    const r = fn(req, res)
    if (r instanceof Promise) r.catch((e: any) => res.status(500).json({ error: e.message }))
  } catch (e: any) {
    res.status(400).json({ error: e.message })
  }
}

// ---------- 健康 & 环境 ----------
app.get('/api/health', wrap((_req, res) => res.json({ ok: true, time: Date.now() })))
app.get('/api/env', wrap((_req, res) => {
  res.json({
    node: process.version,
    toolchains: Object.fromEntries(Object.entries(LANG_PROFILES).map(([k, v]) => [k, { available: v.available, hint: v.installHint }]))
  })
}))

// ---------- FR-01 根路径 ----------
app.get('/api/roots', wrap((_req, res) => res.json(getSettings().roots || [])))
app.post('/api/roots', wrap((req, res) => {
  const { path } = req.body
  if (!path) return res.status(400).json({ error: 'path required' })
  // 路径必须真实存在（容器内 Windows 路径按 LEARNDESK_PATH_MAP 映射后再校验），避免「添加了却扫不到」的静默失败
  if (!existsSync(resolveFsPath(String(path)))) {
    return res.status(400).json({ error: `路径不存在：${path}（容器部署请使用挂载内路径，如 /workspace/xxx）` })
  }
  const settings = getSettings()
  const existing = (settings.roots || []).find((r: any) => r.path.toLowerCase() === String(path).toLowerCase())
  if (existing) return res.json(existing)
  const newRoot = { id: crypto.randomUUID(), path, addedAt: Date.now() }
  saveSettings({ ...settings, roots: [...(settings.roots || []), newRoot] })
  res.json(newRoot)
}))
app.delete('/api/roots/:id', wrap((req, res) => {
  const settings = getSettings()
  saveSettings({ ...settings, roots: (settings.roots || []).filter((r: any) => r.id !== req.params.id) })
  res.json({ ok: true })
}))

// ---------- FR-02/03 扫描与课程 ----------
app.post('/api/scan', wrap(async (_req, res) => {
  await scanRoots()
  res.json({ ok: true, courses: getCourses().length })
}))
app.get('/api/courses', wrap((_req, res) => res.json(getCourses())))
app.get('/api/courses/:id', wrap((req, res) => {
  const course = getCourseById(req.params.id)
  if (!course) return res.status(404).json({ error: 'Not found' })
  res.json(course)
}))
app.put('/api/courses/:id/tags', wrap((req, res) => {
  updateCourseTags(req.params.id, req.body.tags || [])
  res.json({ ok: true })
}))

// ---------- FR-04~06/12 文件 ----------
// 懒加载树：?dir= 返回单层（调研 06 §1.3），支持 name/size/mtime 排序；不传 dir 返回全量（兼容）
app.get('/api/courses/:id/tree', wrap((req, res) => {
  const dir = req.query.dir as string | undefined
  if (dir !== undefined) {
    const sort = (req.query.sort as SortKey) || 'name'
    return res.json(getDirectory(req.params.id, dir, sort))
  }
  res.json(getFileTree(req.params.id))
}))
// 深度搜索（懒加载树不能前端过滤）
app.get('/api/courses/:id/search', wrap((req, res) => {
  const q = (req.query.q as string) || ''
  res.json(searchCourseFiles(req.params.id, q))
}))
// 扁平文件清单（来自索引：含角色/重要度/行数）
app.get('/api/courses/:id/files', wrap((req, res) => res.json(getFlatFiles(req.params.id))))
app.get('/api/courses/:id/file', wrap((req, res) => {
  const { path } = req.query
  if (!path || typeof path !== 'string') return res.status(400).json({ error: 'path required' })
  res.json(getFileContent(req.params.id, path))
}))
app.get('/api/courses/:id/head', wrap((req, res) => res.json(getFileHead(req.params.id))))

// ---------- FR-14 书签（LDD 持久化） ----------
app.get('/api/bookmarks', wrap((req, res) => res.json(getBookmarks(req.query.courseId as string))))
app.put('/api/bookmarks', wrap((req, res) => res.json(setBookmarks(req.body.courseId, req.body.path, req.body.lines || []))))

// ---------- 代码索引（调研 06：符号/依赖/PageRank） ----------
app.get('/api/courses/:id/index', wrap((req, res) => {
  const idx = getIndex(req.params.id)
  if (!idx) return res.json({ missing: true })
  const filesById = new Map(idx.files.map(f => [f.path, f]))
  res.json({
    stale: idx.stale === true,
    generatedAt: idx.generatedAt,
    head: idx.head,
    stats: idx.stats,
    entries: idx.entries.map(p => filesById.get(p)).filter(Boolean),
    topCore: idx.topCore.map(p => filesById.get(p)).filter(Boolean)
  })
}))
app.post('/api/courses/:id/index/refresh', wrap(async (req, res) => res.json(await buildIndex(req.params.id))))
app.get('/api/courses/:id/symbols', wrap((req, res) => {
  const idx = getIndex(req.params.id)
  const p = req.query.path as string
  const f = idx?.files.find(x => x.path === p)
  res.json(f ? { symbols: f.symbols, lang: f.lang, lines: f.lines, readingMinutes: f.readingMinutes, role: f.role, score: f.score, importedBy: f.importedBy.length } : { symbols: [] })
}))

// ---------- FR-07~11 路线 ----------
app.get('/api/courses/:id/routes', wrap((req, res) => res.json(getRoutes(req.params.id))))
app.get('/api/route-templates', wrap((_req, res) => res.json(getRouteTemplates())))
app.post('/api/courses/:id/routes', wrap((req, res) => res.json(saveRoute(req.params.id, req.body))))
app.put('/api/courses/:id/routes/:routeId', wrap((req, res) => res.json(saveRoute(req.params.id, { ...req.body, id: req.params.routeId }))))
app.delete('/api/courses/:id/routes/:routeId', wrap((req, res) => { deleteRoute(req.params.id, req.params.routeId); res.json({ ok: true }) }))
app.post('/api/courses/:id/routes/:routeId/duplicate', wrap((req, res) => res.json(duplicateRoute(req.params.id, req.params.routeId, req.body?.withProgress))))
app.post('/api/courses/:id/routes/:routeId/default', wrap((req, res) => { setDefaultRoute(req.params.id, req.params.routeId); res.json({ ok: true }) }))
app.post('/api/courses/:id/routes/draft', wrap(async (req, res) => {
  const { generateAutoDraft, generateAutoDraftV2 } = await import('./routes.js')
  try {
    // v2：基于代码索引（入口→核心→示例，带行区间与理由）；失败回退 v1 启发式
    res.json(await generateAutoDraftV2(req.params.id, req.body?.name, req.body?.templateId))
  } catch (e: any) {
    console.error('[Draft] v2 失败，回退 v1:', e.message)
    res.json(generateAutoDraft(req.params.id, req.body?.name, req.body?.templateId))
  }
}))
app.post('/api/routes/import-md', wrap((req, res) => res.json(importMdRoute(req.body))))
app.post('/api/routes/gen-ai', wrap(async (req, res) => res.json(await generateAiRouteDraft(req.body))))

// ---------- FR-20~23 进度 ----------
app.get('/api/routes/:id/progress', wrap((req, res) => res.json(getProgress(req.params.id))))
app.put('/api/steps/:key/progress', wrap((req, res) => {
  const [courseId, routeId, stepId] = req.params.key.split('|')
  res.json(updateStepProgress(courseId, routeId, stepId, req.body))
}))

// ---------- FR-22 笔记 ----------
app.get('/api/notes', wrap((req, res) => res.json(getNotes(req.query.courseId as string, req.query.stepId as string))))
app.post('/api/notes', wrap((req, res) => res.json(saveNote(req.body))))
app.delete('/api/notes/:id', wrap((req, res) => { deleteNote(req.params.id); res.json({ ok: true }) }))
app.get('/api/notes/search', wrap((req, res) => res.json(searchNotes(req.query.q as string))))

// ---------- FR-24/25 看板 ----------
app.get('/api/activities', wrap((req, res) => res.json(getActivities(req.query))))
app.get('/api/dashboard', wrap((_req, res) => res.json(getDashboard())))

// ---------- FR-15~18 验证 ----------
app.post('/api/check', wrap((req, res) => res.json(staticCheck(req.body))))
app.post('/api/check/batch', wrap((req, res) => res.json(staticCheckBatch(req.body))))

// 测试执行：ws 流式输出；ok 时若带 routeId/stepId 自动完成该 test 步骤（FR-17）
app.post('/api/test/run', wrap((req, res) => {
  const { courseId, routeId, stepId } = req.body
  const broadcastFn = (msg: any) => {
    broadcast(msg)
    if (msg.type === 'done' && msg.verdict?.ok && routeId && stepId) {
      try { autoCompleteTestStep(courseId, routeId, stepId) } catch {}
    }
  }
  runTest(req.body, broadcastFn)
  res.json({ ok: true, stream: 'ws' })
}))
app.post('/api/test/validate', wrap((req, res) => res.json(validateTest(req.body))))
app.get('/api/tests', wrap((req, res) => res.json(readTestDefs(req.query.courseId as string, req.query.path as string))))
app.post('/api/tests', wrap((req, res) => res.json(saveTestDefs(req.body.courseId, req.body.path, req.body.testDef))))

// ---------- FR-19 预览 ----------
app.post('/api/preview', wrap((req, res) => res.json(getPreviewToken(req.body))))
app.get('/api/preview/:token/*', wrap((req, res) => servePreview(req.params.token, res)))
app.get('/api/preview/:token', wrap((req, res) => servePreview(req.params.token, res)))

// ---------- FR-26/30 设置 ----------
app.get('/api/settings', wrap((_req, res) => res.json(getSettingsMasked())))
// PUT 响应回传脱敏版（E2E 复盘：合并后全量含明文 Key，不回显）
app.put('/api/settings', wrap((req, res) => { saveSettings(req.body); res.json(getSettingsMasked()) }))

// ---------- FR-31 备份 ----------
app.post('/api/backup/export', wrap((_req, res) => res.json(exportBackup())))
app.post('/api/backup/import', wrap((req, res) => res.json(importBackup(req.body))))
app.get('/api/backup/list', wrap((_req, res) => res.json(listBackups())))

// ---------- FR-27~29 AI ----------
app.post('/api/ai/explain', wrap(async (req, res) => res.json(await aiExplain(req.body))))
app.post('/api/ai/chat', wrap(async (req, res) => res.json(await aiChat(req.body))))
// FR-29 翻译：参数在同步 wrap 回调内解析 → 非法请求走 400；provider 的异步异常走既有 500 分支
app.post('/api/ai/translate', wrap((req, res) => {
  const request = parseTranslateRequest(req.body)
  return aiTranslate(request).then(result => res.json(result))
}))
// 批量翻译（整文件注释一次译完，浏览器翻译式渲染的服务端支撑）
app.post('/api/ai/translate-batch', wrap((req, res) => {
  const request = parseTranslateBatchRequest(req.body)
  return aiTranslateBatch(request).then(result => res.json(result))
}))
app.post('/api/ai/gen-route', wrap(async (req, res) => res.json(await generateAiRouteDraft(req.body))))
app.post('/api/ai/test', wrap(async (_req, res) => res.json(await aiTestConnection())))

// ---------- 前端静态资源（单端口生产模式） ----------
// index.html 强制不缓存：升级后浏览器必须拿到新 bundle 引用，避免旧页面「点了没反应」
const clientDist = join(__dirname, '../../client/dist')
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      } else {
        // 带 hash 的资源可长缓存
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    }
  }))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(join(clientDist, 'index.html'))
  })
}

async function start() {
  await initDatabase()
  initSettings()
  probeToolchains()

  console.log('[CodeTrail] 环境自检:')
  console.log('  Node:', process.version)
  for (const [lang, p] of Object.entries(LANG_PROFILES)) {
    console.log(`  ${lang}: ${p.available ? '可用' : '不可用' + (p.installHint ? `（${p.installHint}）` : '')}`)
  }

  httpServer.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[CodeTrail] 地址 ${HOST}:${PORT} 已被占用——很可能已有一个实例在运行。如需重启请先关闭旧进程。`)
      process.exit(1)
    }
    throw e
  })

  httpServer.listen(PORT, HOST, () => {
    console.log(`[CodeTrail] Server running at http://${HOST}:${PORT}`)
    console.log(`[CodeTrail] WebSocket at ws://${HOST}:${PORT}/ws`)
  })

  // 有根路径未扫过时后台补扫（04 §7 启动流程）
  const roots = getSettings().roots || []
  if (roots.length > 0) {
    scanRoots().catch(e => console.error('[CodeTrail] 启动扫描失败:', e.message))
  }
}

// 测试支持：导出 app 供 HTTP 集成测试挂载到随机端口（仅注册路由，不监听）；
// 只有以本文件作为入口运行时才监听 8787，运行时行为不变。
export { app }

function normalizeFileUrl(u: string): string {
  return u.replace(/[?#].*$/, '').replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

const mainUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
const isMain = !!mainUrl && normalizeFileUrl(import.meta.url) === normalizeFileUrl(mainUrl)

if (isMain) {
  start().catch(e => {
    console.error('[CodeTrail] 启动失败:', e)
    process.exit(1)
  })
}
