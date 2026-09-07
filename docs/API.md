# CodeTrail 码途 · 后端接口文档（API Reference）

> 版本：2026-09 · 对应 `app/server/src/index.ts` 全量路由。
> 基址：`http://127.0.0.1:8787`，所有业务接口以 `/api` 开头，JSON 交互。
> 开发模式前端在 `http://localhost:5173`（Vite 代理 `/api` 与 `/ws` 到 8787）；生产模式由后端直接托管 `client/dist`（单端口 8787）。

## 0. 通用约定

| 项 | 约定 |
|---|---|
| 成功 | `200 + JSON`（各接口形状见下） |
| 业务/同步异常 | `400 + { error: string }`（`wrap()` 统一捕获） |
| 异步异常 | `500 + { error: string }` |
| 资源不存在 | `404 + { error: 'Not found' }`（课程）或 `404` 文本（预览） |
| CORS | 仅允许 `http://127.0.0.1:5173`（生产同源无需 CORS） |
| 请求体上限 | `10mb` |
| 路径安全 | 所有文件/目录参数为**相对课程根**的路径；服务端 `resolve` 后强制校验不越出课程根（`Path traversal denied`） |
| 编码 | UTF-8 优先，非法替代符自动回退 GBK（响应 `encoding` 字段标注） |

### 核心 ID 规则
- **courseId**：`repo:<目录名>` 或 `docs:<目录名>`（扫描器生成，含 `:`，URL 中必须 `encodeURIComponent`）
- **stepProgress 主键**：`courseId|routeId|stepId` 三段拼接（见 §7）

---

## 1. 健康与环境

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ ok: true, time }`，start.bat 轮询用 |
| GET | `/api/env` | `{ node, toolchains: { python/go/javascript: { available, hint } } }` 运行时探针（`probeToolchains()` 结果） |

## 2. 根路径与扫描（FR-01/02/03）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/roots` | — | `[{ id, path, addedAt }]` |
| POST | `/api/roots` | `{ path }` | 新建或命中的 root（大小写去重） |
| DELETE | `/api/roots/:id` | — | `{ ok: true }` |
| POST | `/api/scan` | — | `{ ok: true, courses: n }`（全量重扫，见 §3 规则） |
| GET | `/api/courses` | — | `Course[]`（见 §12 数据模型） |
| GET | `/api/courses/:id` | — | `Course` 或 404 |
| PUT | `/api/courses/:id/tags` | `{ tags: string[] }` | `{ ok: true }`（接口已有，前端暂无 UI） |

## 3. 文件（FR-04/05/06/12）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/courses/:id/tree?dir=&sort=` | `dir`＝相对目录（空串＝根；**不传 dir＝返回全量树**兼容旧版）；`sort`＝`name\|size\|mtime` | 传 dir：`{ path, nodes: FileNode[], fileCount, dirCount, truncated }`；不传：`{ tree, groups, truncated, totalFiles }` |
| GET | `/api/courses/:id/search?q=` | 关键词 | `[{ path, name, type }]`，全树遍历上限 300 条、深度 10 |
| GET | `/api/courses/:id/files` | — | `[{ path, role?, score?, lines? }]` 扁平清单（来自索引） |
| GET | `/api/courses/:id/file?path=&startLine=&endLine=` | — | `{ content, truncated, encoding, startLine, endLine, totalLines, partial }` |
| GET | `/api/courses/:id/head` | — | README 前 5 行字符串 |

**分片策略**：≤512KB 全量返回；>512KB 按行窗口（默认 2000 行）续载，`partial: true` 时前端可带 `startLine/endLine` 再取；>2MB 仅解码前 256KB 并 `truncated: true`。
**懒加载树**：单目录节点 >800 截断；`isRouteFile` 标记路线收录文件；忽略集 `.git node_modules .venv venv __pycache__ target dist build .idea .vscode .learndesk`。

## 4. 书签（FR-14）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/bookmarks?courseId=` | — | `{ [relPath]: number[] }`（存 LDD `bookmarks/<course>.json`，不写仓库） |
| PUT | `/api/bookmarks` | `{ courseId, path, lines: number[] }` | `{ lines }`（整表覆盖） |

## 5. 代码索引（aider Repo Map 轻量版）

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/courses/:id/index` | 无索引：`{ missing: true }`；有：`{ stale, generatedAt, head, stats, entries: IndexedFile[], topCore: IndexedFile[] }`（≤8 核心文件） |
| POST | `/api/courses/:id/index/refresh` | 重建并返回完整 `CourseIndex` |
| GET | `/api/courses/:id/symbols?path=` | `{ symbols: FileSymbol[], lang, lines, readingMinutes, role, score, importedBy }` |

**算法**：符号提取（Python 走 `ast`，JS/Go 正则）→ 内部 import 依赖图 → PageRank（0~100 分）→ 角色判定（`core/entry/example/doc/test/config/other`）。
**失效键**：git HEAD 变化或 `ALGO_VERSION` 递增 → `stale: true`；持久化于 LDD `index/<course>.json`。

## 6. 路线（FR-07~11）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/courses/:id/routes` | — | `Route[]`（定义 JSON 存 LDD `routes/`，DB 只存索引） |
| POST | `/api/courses/:id/routes` | `Route`（含 steps） | 保存后的 `Route` |
| PUT | `/api/courses/:id/routes/:routeId` | 同上 | 同上（复制路线进度时同步迁移 step id） |
| DELETE | `/api/courses/:id/routes/:routeId` | — | `{ ok: true }`（连带删除该路线 progress） |
| POST | `/api/courses/:id/routes/:routeId/duplicate` | `{ withProgress?: boolean }` | 新 `Route` |
| POST | `/api/courses/:id/routes/:routeId/default` | — | `{ ok: true }`（同课程互斥） |
| POST | `/api/courses/:id/routes/draft` | `{ name? }` | **自动梳理 v2**：基于索引「入口→核心→示例」生成带行区间与理由的 `Route`；v2 失败回退启发式 v1 |
| POST | `/api/routes/import-md` | `{ courseId, mdPath, routeName?, section? }` | `Route & { warnings: string[] }`（解析标题层级 + `path:Lx-Ly` 引用） |
| POST | `/api/routes/gen-ai` | `{ courseId, prompt?, name? }` | `{ steps: Step[] }` 或 `{ steps: [], error }`（草案不落库，前端确认后走 POST routes） |

## 7. 进度（FR-20/21/23）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/routes/:id/progress` | — | `{ [stepId]: StepProgress }` |
| PUT | `/api/steps/:key/progress` | `key = courseId\|routeId\|stepId`（URL 编码）；body `{ status?, selfRating?\|self_rating?, action? }` | 最新 `StepProgress` |

**状态机**：`todo → doing → done|skipped`；置 `done` 时写 `done_at` 并设 `review_due_at = +7天`；`done → doing`（复习/回改）清空两字段。
**副作用**：同事务追加 `activities` 流水；WS 广播 `{ type:'progress', courseId, routeId, stepId, progress }`。
**自动完成**：测试通过（见 §9）时若带 `routeId/stepId`，服务端自动 `status=done, action=test_passed`。
> ⚠ 2026-09 修复：前端一直发 `self_rating`（蛇形）而服务端旧代码只读 `selfRating`，UI 自评不落库；现已两种键兼容。新增字段时**务必保持蛇形**（与 DB 列名一致）。

## 8. 笔记（FR-22）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/notes?courseId=&stepId=` | — | `Note[]`，附 `__content`（正文，存 LDD `notes/<id>.md`） |
| POST | `/api/notes` | `{ courseId, stepId?, title, content, filePath?, rangeStart?, rangeEnd? }` | `{ id, ... }`；**id = `course__step`（或 `course__global`）幂等覆盖** |
| DELETE | `/api/notes/:id` | — | `{ ok: true }` |
| GET | `/api/notes/search?q=` | — | `[{ ...note, snippet }]` 标题+正文命中，≤50 条 |

## 9. 验证：静态检查 / 测试 / 预览（FR-15~19）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/check` | `{ courseId, path }` | `{ kind:'static', ok, items:[{line,msg,src}], ms, lang?, unavailable? }`（py_compile / node --check / go vet；工具链缺失 `unavailable` 降级） |
| POST | `/api/check/batch` | `{ courseId, paths[] }` | `[{ path, ok, issues, unavailable? }]` |
| GET | `/api/tests?courseId=&path=` | — | 该文件的 `TestDef`（LDD `tests/` JSON） |
| POST | `/api/tests` | `{ courseId, path, testDef }` | `{ saved }` |
| POST | `/api/test/validate` | `{ testDef }` | `{ ok, error? }` 配置合法性预检 |
| POST | `/api/test/run` | `{ courseId, path, testDef, routeId?, stepId? }` | 立即返回 `{ ok:true, stream:'ws' }`，**结果走 WS**（§11） |
| POST | `/api/preview` | `{ courseId, path }` | `{ token, url: /api/preview/<token>, kind: md\|static\|file }`（复制副本进 LDD/preview，**5 分钟无访问自动清理**） |
| GET | `/api/preview/:token/*` | — | 渲染后的 HTML / 静态资源 |

**TestDef 两模型**：
- `m1` 输出比对：运行目标文件（python=uv / node / go run），`expect.stdoutInclude / stdoutExact / exitOk` 判定；
- `m2` 断言脚本：`entry`（相对课程根的测试脚本）+ `runtime`，退出码判定。
**执行安全**：临时目录/字节码重定向 LDD/tmp（保留最近 20 次）；30s 超时 SIGKILL；stdout/stderr >200KB 即杀；Windows GBK 控制台输出自动解码。

## 10. 看板（FR-24/25）

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/api/dashboard` | `{ courses: [{ course, routes: [{routeId, routeName, isDefault, total, done, doing, percent, nextStep}], lastActive, totalSteps, totalDone }], heatmap: [{day, count}]（近30天按天聚合，升序）, reviewQueue: [StepProgress & {route_name, course_slug, step_title}]（自评≤3 或到期，≤20）, nextSteps: [{stepId,title,type,courseId,courseName,routeId,routeName}] }` |
| GET | `/api/activities?courseId=&routeId=&since=&limit=` | `Activity[]`（倒序） |

## 11. WebSocket `/ws`

服务端→客户端单向广播（无入站协议）：

```jsonc
{ "type": "progress", "courseId": "...", "routeId": "...", "stepId": "...", "progress": { /* StepProgress */ } }
{ "type": "exec", "stream": "stdout" | "stderr", "chunk": "..." }   // 测试输出流
{ "type": "done", "verdict": { "ok": true, "exitCode": 0, "stdout": "...", "stderr": "..." } }
// verdict 失败时含 { ok:false, error, timedOut? }
```
客户端：App 收 `progress` 实时刷新；EditorArea 收 `exec/done` 渲染测试日志与判定。断线各自 3s 重连。

## 12. 设置与备份（FR-26/30/31）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/settings` | — | `Settings`，**apiKey 脱敏为 `••••••••(已配置)`** |
| PUT | `/api/settings` | `Partial<Settings>` | **响应回传脱敏版**；`ai.apiKey` 含 `•`（掩码原样回传或编辑残留）一律视为未修改、保留原 Key（守卫在合并前取旧值），显式清空传 `''`；provider/model/baseURL 空串自动回退默认 |
| POST | `/api/backup/export` | — | `{ file, size }`（WAL 落盘后 tar 打包 db+routes+tests+notes → LDD/backups/zip；**不含 settings/tmp**） |
| POST | `/api/backup/import` | `{ file }` | `{ ok, message }`（覆盖前原库改名 `db.sqlite.pre-import.<ts>`，导入后 reopen） |
| GET | `/api/backup/list` | — | `[{ file, size, mtime }]` 倒序 |

**Settings 形状**：
```ts
{ roots: [{id, path, addedAt}], ai: AiSettings, scanCache: {path: mtime}, debug, ui: {theme, fontSize} }
// AiSettings: { provider:'anthropic'|'openai', apiKey, model, baseURL?, maxTokens, temperature }
// ⚠ ui.theme 已废弃：五主题改由前端 localStorage('ct-theme') 管理（v3.x 设计），后端字段仅为兼容保留
```

## 13. AI（FR-27~29）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/api/ai/explain` | `{ courseId, file, selection, context?, stepNote? }` | `{ content }` / `{ content:'', error }`；上下文自动构建：README 摘要 + 同文件 import 的相关文件（≤3 个，各 60 行） |
| POST | `/api/ai/chat` | `{ courseId, messages:[{role,content}], routeContext?:{stepTitle,stepNote,file?} }` | `{ content }`；服务端截尾 10 条、单条 2000 token、注入学习助手 system |
| POST | `/api/ai/translate` | `{ courseId?, text, targetLang?:'zh' }` | `{ content }` / `{ content:'', error }`；只翻译非代码内容，结果不落库；参数错误 400（同步边界解析）、未预期异步异常 500 |
| POST | `/api/ai/gen-route` | 同 §6 gen-ai | 同 |
| POST | `/api/ai/test` | — | `{ ok, message, model? }` |

**Provider 适配**：`openai` 或 baseURL 含 `openai/azure` → `{base}/chat/completions` Bearer；否则 Anthropic `{base}/v1/messages` x-api-key。默认模型 `claude-sonnet-4-5`。未配 Key 一律返回 `{ error: 'AI 未配置…' }`，其余功能不受影响。

**翻译**（FR-29，`/api/ai/translate`）：`text` 必须非空、估算 ≤6000 tokens（复用既有上下文预算，**不静默截断**）；`targetLang` 仅允许 `'zh'`（缺省即 `'zh'`）；`courseId` 可选，提供时只校验课程存在，不读取课程文件、不注入 README。无 Key / 课程不存在 / provider 非 2xx / 网络失败 / 空响应均返回 **200** `{ content:'', error }`（沿用 `callAi()` 错误前缀）。实现不写 `text` 日志、不落 LDD、不进 `activities`/备份；是否触发翻译由前端决定，代码本体永不翻译。

## 14. 数据模型速查

```ts
Course       { id, kind:'repo'|'docs', root, slug, lang, label, tags[], scan_meta{remote,lastCommit,files,dirs,bytes,truncated,readmeSummary,mdFiles}, missing, last_scan_at }
FileNode     { name, path, type:'file'|'directory', size?, mtime?, isRouteFile? }        // 全量树版含 children/group/role/score
Route        { id, courseId, name, order, is_default?, steps: Step[] }                    // def 存 LDD/routes/<course>/<id>.json
Step         { id, type:'file'|'doc'|'test'|'checkpoint', title, file?, range?:[a,b], note?, testRef? }
StepProgress { course_id, route_id, step_id, status:'todo'|'doing'|'done'|'skipped', self_rating?, last_open_at?, done_at?, review_due_at? }
IndexedFile  { path, lang, lines, size, symbols: FileSymbol[], imports[], importedBy[], score, role, readingMinutes }
FileSymbol   { name, kind:'class'|'function'|'method'|'type'|'const', line, end, doc }
Activity     { id, at, course_id, route_id, step_id, action, payload }
TestDef      { model:'m1'|'m2', cmdLang?, stdin?, expect?:{stdoutInclude?,stdoutExact?,exitOk?}, entry?, runtime? }
```

## 15. 存储布局（LDD = `<工作区根>\.learndesk`，可用 `LEARNDESK_DIR` 覆盖）

```
.learndesk/
├── db.sqlite          courses/routes/step_progress/activities/settings/notes（WAL）
├── settings.json      roots + AI Key（明文仅本机，API 脱敏）
├── routes/<course>/<routeId>.json   路线定义
├── tests/<course>/<file>.json       TestDef
├── notes/<id>.md                    笔记正文
├── index/<course>.json              代码索引缓存
├── bookmarks/<course>.json          书签
├── preview/<token>/                 预览副本（5min TTL）
├── tmp/<runId>/                     测试沙箱（保留最近 20）
└── backups/codetrail-backup-<ts>.zip
```

## 16. 限制一览（改行为前先对照）

| 项 | 值 | 位置 |
|---|---|---|
| 全量读文件 | ≤512KB | fileService |
| 大文件解码 | 前 256KB | fileService |
| 单目录节点 | ≤800 | getDirectory |
| 搜索 | ≤300 条 / 深度 10 | searchCourseFiles |
| 扫描遍历 | ≤5000 文件 / 深度 8 | scanner.walkStats |
| 测试执行 | 30s 超时 / 输出 200KB 截断 | executor |
| 预览存活 | 5min 无访问 | preview |
| AI 上下文 | 6000 token 预算（翻译为硬上限、不截断）/ 截尾 10 条 | ai.ts |
| 备份 | tar(bsdtar) zip | backup |
