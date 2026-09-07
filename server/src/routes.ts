import { run, getRow, getAll, getLddPath } from './db/index.js'
import { getCourseById } from './scanner.js'
import { getRoots } from './settings.js'
import { resolveFsPath } from './paths.js'
import { getFlatFiles } from './fileService.js'
import { aiGenerateRoute } from './ai.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join, relative, resolve, extname } from 'path'

export interface Step {
  id: string
  type: 'file' | 'doc' | 'test' | 'checkpoint'
  title: string
  file?: string          // 相对课程根的路径
  range?: [number, number]
  note?: string
  testRef?: string
  stage?: string
  slot?: string
}

export interface Route {
  id: string
  courseId: string
  name: string
  order: number
  is_default?: boolean
  steps: Step[]
  templateId?: RouteTemplateId
}

export type RouteTemplateId =
  | 'codebase-onboarding' | 'feature-trace' | 'bug-investigation' | 'api-integration'
  | 'project-decomposition' | 'example-driven' | 'deep-module'

export interface RouteSlot {
  id: string
  stage: string
  type: Step['type']
  label: string
  required: boolean
  guide?: string   // 给生成模型（含低级模型）的填空说明：这个槽位应该放什么、怎么挑文件
}

export interface RouteTemplate {
  id: RouteTemplateId
  name: string
  audience: string
  description: string
  stages: readonly string[]
  slots: readonly RouteSlot[]
}

function slots(stages: readonly string[], values: readonly { id: string; stage: number; type: Step['type']; label: string; required?: boolean; guide?: string }[]) {
  return values.map(value => ({ ...value, stage: stages[value.stage] || stages[0], required: value.required !== false }))
}

export const ROUTE_TEMPLATES: readonly RouteTemplate[] = [
  {
    id: 'codebase-onboarding', name: '代码库入门', audience: '第一次阅读陌生仓库',
    description: '先定位，再追入口和核心抽象，最后用最小示例验证。',
    stages: ['定位', '概念', '入口', '核心', '示例', '复盘'],
    slots: slots(['定位', '概念', '入口', '核心', '示例', '复盘'], [
      { id: 'orientation', stage: 0, type: 'doc', label: '项目定位与 README', guide: '放 README.md 或同等入口文档；没有 README 就放 docs 下最像总览的一篇。' },
      { id: 'concepts', stage: 1, type: 'doc', label: '概念或架构说明', required: false, guide: 'docs/ 下含 architecture/concept/overview/intro 关键词的文档；没有可留空。' },
      { id: 'entry', stage: 2, type: 'file', label: '启动入口', guide: '程序从这里开始运行：main/cli/__main__/index/app 或 examples 的启动脚本；优先候选文件中角色为 entry 的。' },
      { id: 'core', stage: 3, type: 'file', label: '核心抽象', guide: '被引用最多、重要度最高的 1~2 个文件（如 agent/model/memory 等主抽象定义处）。' },
      { id: 'example', stage: 4, type: 'file', label: '最小可运行示例', required: false, guide: 'examples/ 下行数最少、名字含 hello/basic/quickstart 的脚本。' },
      { id: 'reflection', stage: 5, type: 'checkpoint', label: '复盘检查点', guide: '无文件；写一个能让学习者自测的问题（如：用三句话讲清核心调用链）。' }
    ])
  },
  {
    id: 'feature-trace', name: '功能链路追踪', audience: '理解一个功能如何落地',
    description: '从用户入口追到服务边界、数据流和可观测验证点。',
    stages: ['问题定义', '入口', '数据流', '实现', '验证', '复盘'],
    slots: slots(['问题定义', '入口', '数据流', '实现', '验证', '复盘'], [
      { id: 'problem', stage: 0, type: 'doc', label: '问题与成功标准', guide: '描述该功能的文档/注释/测试名；没有文档就用承载该功能语义的 README 章节。' },
      { id: 'entry', stage: 1, type: 'file', label: '功能入口', guide: '用户触发该功能的第一个函数/路由/CLI 命令所在文件。' },
      { id: 'flow', stage: 2, type: 'file', label: '数据流节点', guide: '数据被转换/传递的中间层文件（client、transport、serializer 等）。' },
      { id: 'implementation', stage: 3, type: 'file', label: '实现核心', guide: '真正完成该功能的主实现文件，给出关键类/函数的行区间。' },
      { id: 'verification', stage: 4, type: 'test', label: '验证与断言', guide: '覆盖该功能的测试文件；没有测试就设计一个手动验证检查点。' },
      { id: 'reflection', stage: 5, type: 'checkpoint', label: '链路复盘', guide: '无文件；要求画出「入口→实现→输出」的调用链。' }
    ])
  },
  {
    id: 'bug-investigation', name: '故障排查', audience: '定位异常与回归风险',
    description: '固定现象、缩小范围、验证假设，再留下可复现的回归证据。',
    stages: ['复现', '边界', '假设', '修复', '回归', '复盘'],
    slots: slots(['复现', '边界', '假设', '修复', '回归', '复盘'], [
      { id: 'reproduce', stage: 0, type: 'test', label: '最小复现', guide: '能稳定复现问题的测试或脚本；教学场景可指认一个已有失败用例。' },
      { id: 'boundary', stage: 1, type: 'file', label: '边界与输入', guide: '参数校验/输入解析所在文件。' },
      { id: 'hypothesis', stage: 2, type: 'file', label: '假设相关实现', guide: '最可能出问题的实现文件。' },
      { id: 'fix', stage: 3, type: 'file', label: '修复位置', guide: '预期需要改动的函数所在文件，给行区间。' },
      { id: 'regression', stage: 4, type: 'test', label: '回归验证', guide: '修复后必须保持通过的测试文件。' },
      { id: 'reflection', stage: 5, type: 'checkpoint', label: '故障复盘', guide: '无文件；总结根因与预防手段。' }
    ])
  },
  {
    id: 'api-integration', name: 'API 集成', audience: '接入模型或第三方服务',
    description: '先读契约，再看适配器、错误边界和真实请求验证。',
    stages: ['契约', '配置', '适配器', '错误处理', '联调', '复盘'],
    slots: slots(['契约', '配置', '适配器', '错误处理', '联调', '复盘'], [
      { id: 'contract', stage: 0, type: 'doc', label: 'API 契约', guide: '描述请求/响应格式的文档或类型定义文件。' },
      { id: 'config', stage: 1, type: 'file', label: '配置与凭据边界', guide: '读取密钥/端点的配置模块（env/config/settings 类文件）。' },
      { id: 'adapter', stage: 2, type: 'file', label: '请求适配器', guide: '真正发 HTTP 请求或封装 SDK 的文件（client/transport/api 类）。' },
      { id: 'errors', stage: 3, type: 'file', label: '错误处理', guide: '异常分类、重试、限流处理所在文件。' },
      { id: 'integration', stage: 4, type: 'test', label: '联调测试', guide: '真实或 mock 的集成测试文件。' },
      { id: 'reflection', stage: 5, type: 'checkpoint', label: '集成复盘', guide: '无文件；梳理一次完整请求的生命周期。' }
    ])
  },
  {
    id: 'project-decomposition', name: '项目拆解', audience: '把大仓库拆成可消化的模块地图',
    description: '从全景到骨架再到模块逐个击破，产出可挂在文件树上的模块地图。',
    stages: ['全景', '骨架', '入口', '核心模块', '支撑设施', '复盘'],
    slots: slots(['全景', '骨架', '入口', '核心模块', '支撑设施', '复盘'], [
      { id: 'panorama', stage: 0, type: 'doc', label: '全景：项目是做什么的', guide: 'README 或 docs 总览；note 里写一句话定位（给谁用、解决什么问题）。' },
      { id: 'skeleton', stage: 1, type: 'file', label: '骨架：目录结构导览', guide: '选 1 个最能代表项目布局的文件（如顶层 __init__.py / go.mod / package.json），note 里列出 3~5 个主要目录及职责。' },
      { id: 'entry', stage: 2, type: 'file', label: '入口：从哪里跑起来', guide: '角色为 entry 的文件；CLI 项目放 cli/main。' },
      { id: 'modules', stage: 3, type: 'file', label: '核心模块', guide: '重要度最高的 2~4 个模块文件，每个一条步骤；note 写该模块职责与关键类名。' },
      { id: 'support', stage: 4, type: 'doc', label: '支撑设施', required: false, guide: 'tests/、CI 配置、docs 等支撑内容的位置说明。' },
      { id: 'map', stage: 5, type: 'checkpoint', label: '复盘：画出模块地图', guide: '无文件；要求学习者写出「目录 → 职责 → 依赖方向」三列表。' }
    ])
  },
  {
    id: 'example-driven', name: '示例驱动上手', audience: '先跑起来再懂原理',
    description: '跑通最小示例 → 倒查实现 → 自己动手复刻与变体。',
    stages: ['跑通', '示例', '原理', '复刻', '变体', '复盘'],
    slots: slots(['跑通', '示例', '原理', '复刻', '变体', '复盘'], [
      { id: 'setup', stage: 0, type: 'doc', label: '环境与安装', guide: 'README 的安装章节或 requirements/pyproject 所在文件。' },
      { id: 'example', stage: 1, type: 'file', label: '最小可运行示例', guide: 'examples/ 下最短、名字含 hello/basic/quickstart 的脚本。' },
      { id: 'principle', stage: 2, type: 'file', label: '示例背后的实现', guide: '示例 import 的核心实现文件，给关键类行区间。' },
      { id: 'clone', stage: 3, type: 'test', label: '复刻：自己写一遍', guide: '验证方式 = 不看原文重写最小示例并运行成功。' },
      { id: 'variant', stage: 4, type: 'test', label: '变体：改参数验证理解', required: false, guide: '改一个关键参数（模型/温度/工具数）预测结果再验证。' },
      { id: 'reflection', stage: 5, type: 'checkpoint', label: '复盘', guide: '无文件；总结示例用到哪些核心抽象。' }
    ])
  },
  {
    id: 'deep-module', name: '核心模块精读', audience: '吃透一个关键模块',
    description: '边界 → 接口 → 实现 → 依赖 → 测试，五步精读单个模块。',
    stages: ['边界', '接口', '实现', '依赖', '测试', '复盘'],
    slots: slots(['边界', '接口', '实现', '依赖', '测试', '复盘'], [
      { id: 'boundary', stage: 0, type: 'doc', label: '模块职责边界', guide: '模块的文档/注释/docstring 所在文件；note 写它负责什么、不负责什么。' },
      { id: 'api', stage: 1, type: 'file', label: '对外接口', guide: '__init__.py / types / models 等定义公开 API 的文件。' },
      { id: 'impl', stage: 2, type: 'file', label: '主流程实现', guide: '模块内最重要、行数最多的实现文件，给核心类行区间。' },
      { id: 'deps', stage: 3, type: 'file', label: '上下游依赖', required: false, guide: '被它 import 或 import 它的关键文件。' },
      { id: 'tests', stage: 4, type: 'test', label: '测试即文档', guide: '该模块对应的测试文件；跑一遍测试作为验收。' },
      { id: 'reflection', stage: 5, type: 'checkpoint', label: '复盘：白板重写', guide: '无文件；合上代码画出模块内类/函数关系图。' }
    ])
  }
] as const

function getTemplate(templateId?: string): RouteTemplate {
  return ROUTE_TEMPLATES.find(t => t.id === templateId) || ROUTE_TEMPLATES[0]
}

export function getRouteTemplates(): RouteTemplate[] {
  return ROUTE_TEMPLATES.map(t => ({ ...t, stages: [...t.stages], slots: t.slots.map(slot => ({ ...slot })) }))
}

function getRouteDir(courseId: string) {
  return join(getLddPath(), 'routes', courseId.replace(/[\\/:*?"<>|]/g, '_'))
}

function getRoutePath(courseId: string, routeId: string) {
  return join(getRouteDir(courseId), `${routeId.replace(/[\\/:*?"<>|]/g, '_')}.json`)
}

export function getRoutes(courseId: string): Route[] {
  const rows = getAll('SELECT * FROM routes WHERE course_id = ? ORDER BY "order"', [courseId]) as any[]
  const routes: Route[] = []
  for (const row of rows) {
    try {
      const def = JSON.parse(readFileSync(row.def_path, 'utf8'))
      def.is_default = !!row.is_default
      routes.push(def)
    } catch {}
  }
  return routes
}

function logRouteActivity(courseId: string, detail: string) {
  run(`INSERT INTO activities (at, course_id, route_id, step_id, action, payload) VALUES (?, ?, '', '', 'route_change', ?)`,
    [Date.now(), courseId, detail])
}

/** 同一课程内路线名去重：重名自动加「·2 / ·3」后缀，看板不再出现一排同名任务 */
function uniqueRouteName(courseId: string, name: string, selfId: string): string {
  const taken = new Set(
    getAll('SELECT name FROM routes WHERE course_id = ? AND id != ?', [courseId, selfId])
      .map((r: any) => String(r.name || ''))
  )
  if (!taken.has(name)) return name
  let n = 2
  while (taken.has(`${name}·${n}`)) n++
  return `${name}·${n}`
}

export function saveRoute(courseId: string, route: Partial<Route> & { steps: Step[] }): Route {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')

  const routeId = route.id || `route-${Date.now()}`
  const routeDir = getRouteDir(courseId)
  mkdirSync(routeDir, { recursive: true })
  const routePath = getRoutePath(courseId, routeId)

  const existing = getRow('SELECT * FROM routes WHERE id = ?', [routeId]) as any
  const orderResult = getRow('SELECT MAX("order") as m FROM routes WHERE course_id = ?', [courseId]) as any
  const order = existing?.order || (orderResult?.m || 0) + 1
  const template = getTemplate(route.templateId || existing?.templateId)

  const fullRoute: Route = {
    id: routeId,
    courseId,
    name: uniqueRouteName(courseId, route.name || existing?.name || '新路线', routeId),
    order,
    is_default: route.is_default ?? !!existing?.is_default,
    steps: fillTemplate(route.steps, template),
    templateId: template.id
  }

  writeFileSync(routePath, JSON.stringify(fullRoute, null, 2))

  if (existing) {
    run('UPDATE routes SET name = ?, def_path = ?, is_default = ? WHERE id = ?', [fullRoute.name, routePath, fullRoute.is_default ? 1 : 0, routeId])
  } else {
    // 该课程第一条路线自动设为默认（FR-07）
    const isFirst = !orderResult?.m
    run('INSERT INTO routes (id, course_id, name, def_path, "order", is_default) VALUES (?, ?, ?, ?, ?, ?)',
      [routeId, courseId, fullRoute.name, routePath, order, fullRoute.is_default || isFirst ? 1 : 0])
  }

  logRouteActivity(courseId, fullRoute.name)
  return fullRoute
}

export function deleteRoute(courseId: string, routeId: string) {
  const row = getRow('SELECT def_path FROM routes WHERE id = ? AND course_id = ?', [routeId, courseId]) as any
  if (row?.def_path) {
    try { unlinkSync(row.def_path) } catch {}
  }
  run('DELETE FROM routes WHERE id = ? AND course_id = ?', [routeId, courseId])
  run('DELETE FROM step_progress WHERE course_id = ? AND route_id = ?', [courseId, routeId])
  logRouteActivity(courseId, `删除路线 ${routeId}`)
}

export function duplicateRoute(courseId: string, routeId: string, withProgress = false): Route {
  const source = getRoutes(courseId).find(r => r.id === routeId)
  if (!source) throw new Error('Route not found')
  const saved = saveRoute(courseId, {
    ...source,
    id: `route-${Date.now()}`,
    name: `${source.name}（副本）`,
    is_default: false
  })
  if (withProgress) {
    const rows = getAll('SELECT * FROM step_progress WHERE course_id = ? AND route_id = ?', [courseId, routeId]) as any[]
    for (const p of rows) {
      run(`INSERT OR REPLACE INTO step_progress (course_id, route_id, step_id, status, self_rating, last_open_at, done_at, review_due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.course_id, saved.id, p.step_id, p.status, p.self_rating, p.last_open_at, p.done_at, p.review_due_at])
    }
  }
  return saved
}

export function setDefaultRoute(courseId: string, routeId: string) {
  run('UPDATE routes SET is_default = 0 WHERE course_id = ?', [courseId])
  run('UPDATE routes SET is_default = 1 WHERE id = ? AND course_id = ?', [routeId, courseId])
  logRouteActivity(courseId, `设默认路线 ${routeId}`)
}

// ---------- FR-10① 自动草案（v2：基于代码索引 —— 调研文档 06 §3） ----------

/** 基于符号索引的智能路线：入口 → 核心(top rank, 带行区间与自动说明) → 示例 → 检查点 */
export async function generateAutoDraftV2(courseId: string, name?: string, templateId?: RouteTemplateId): Promise<Route> {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')
  const { buildIndex } = await import('./indexer.js')
  const index = await buildIndex(courseId)
  const byPath = new Map(index.files.map(f => [f.path, f]))

  const steps: Step[] = []
  const template = getTemplate(templateId)
  let idx = 0
  const push = (s: Omit<Step, 'id'>) => { steps.push({ id: `s${++idx}`, ...s }) }
  const fmtSyms = (f: NonNullable<ReturnType<typeof byPath.get>>) =>
    f.symbols.filter(s => s.kind === 'class' || s.end - s.line > 15).slice(0, 3)
      .map(s => `L${s.line} ${s.name}`).join('、')

  // 1. README
  const readme = listTop(course.root, e => e.isFile() && /^readme\.md$/i.test(e.name))[0]
  if (readme) push({ stage: template.stages[0], type: 'doc', title: `${template.stages[0]}：通读 README`, file: readme.name, note: '先抓定位、核心概念、安装方式' })

  // 2. 架构/设计文档（docs 下最像架构说明的 1~2 篇）
  const archDocs = index.files
    .filter(f => f.role === 'doc' && /concept|architect|intro|overview|guide|getting|design/i.test(f.path))
    .sort((a, b) => a.path.length - b.path.length)
    .slice(0, 2)
  for (const d of archDocs) {
    push({ stage: template.stages[1], type: 'doc', title: `${template.stages[1]}：${d.path.split('/').pop()}`, file: d.path, note: `约 ${d.readingMinutes} 分钟 · 建立概念框架` })
  }

  // 3. 入口（最多 2 个）：从入口读起，理解启动流程
  for (const p of index.entries.slice(0, 2)) {
    const f = byPath.get(p)
    if (!f) continue
    const mainSym = f.symbols.find(s => /main|run|serve|start|cli/i.test(s.name)) || f.symbols[0]
    push({
      stage: template.stages[2], type: 'file', title: `${template.stages[2]}：${p.split('/').pop()}`,
      file: p,
      range: mainSym ? [mainSym.line, Math.min(mainSym.end, mainSym.line + 80)] : undefined,
      note: `入口文件，引用 ${f.imports.length} 个内部模块（${f.imports.slice(0, 3).map(i => i.split('/').pop()).join('、')}…）。先看调用链入口再看分支。约 ${f.readingMinutes} 分钟`
    })
  }

  // 4. 核心文件（PageRank top，最多 5 个）：最重要的抽象，给出行区间与理由
  for (const p of index.topCore.slice(0, 5)) {
    const f = byPath.get(p)
    if (!f) continue
    const biggest = [...f.symbols].sort((a, b) => (b.end - b.line) - (a.end - a.line))[0]
    push({
      stage: template.stages[3], type: 'file', title: `${template.stages[3]}：${p.split('/').pop()}${biggest ? ` · ${biggest.name}` : ''}`,
      file: p,
      range: biggest ? [biggest.line, biggest.end] : undefined,
      note: [
        `重要度 ${f.score}/100 · 被 ${f.importedBy.length} 个文件引用（框架的核心抽象）`,
        f.symbols.length ? `关键符号：${fmtSyms(f)}` : '',
        `约 ${f.readingMinutes} 分钟 · 建议配合 AI 讲解读主流程`
      ].filter(Boolean).join('\n')
    })
  }

  // 5. 一个最简单的示例（先跑通再读）
  const examples = index.files
    .filter(f => f.role === 'example' && ['python', 'go', 'javascript', 'typescript'].includes(f.lang))
    .sort((a, b) => a.lines - b.lines)
  const simpleEx = examples.find(f => /hello|basic|quick|minimal|first/i.test(f.path)) || examples[0]
  if (simpleEx) {
    push({ stage: template.stages[4], type: 'file', title: `${template.stages[4]}：${simpleEx.path.split('/').pop()}`, file: simpleEx.path, note: `最短示例（${simpleEx.lines} 行）· 用「测试闯关」跑通它` })
  }

  // 6. 检查点
  push({ stage: template.stages[5], type: 'checkpoint', title: `${template.stages[5]}：画出模块依赖方向`, note: '用笔记回答：入口到核心的调用链是什么？为什么这几个文件最重要？' })

  if (steps.length === 0) {
    push({ stage: template.stages[0], type: 'checkpoint', title: '空路线：请手动添加步骤或导入 md 指南' })
  }
  return saveRoute(courseId, { name: name || suggestRouteName(template, steps), steps: fillTemplate(steps, template), templateId: template.id })
}

/** 语义化默认名：模板名 + 首个「位于子目录」步骤的目录名，避免整屏同名路线 */
function suggestRouteName(template: RouteTemplate, steps: Step[]): string {
  const withDir = steps.find(s => s.file && s.file.includes('/'))
  if (!withDir?.file) return template.name
  const segs = withDir.file.split('/')
  return `${template.name} · ${segs[segs.length - 2]}`
}

// ---------- FR-10① 自动草案（v1 启发式，作为索引失败时的回退） ----------

const CORE_DIRS = ['src', 'lib', 'pkg', 'core', 'agent', 'agents', 'smolagents', 'python', 'go']
const IGNORE_TOP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.agents'])

function listTop(dir: string, filter?: (e: any) => boolean): any[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => !IGNORE_TOP.has(e.name) && (!filter || filter(e)))
  } catch { return [] }
}

const SKIP_DOC_NAME = /changelog|contributing|license|code_of_conduct|security/i

/** 启发式：README → docs/（字母序）→ examples/（从简到繁）→ 核心源码 → 检查点 */
export function generateAutoDraft(courseId: string, name?: string, templateId?: RouteTemplateId): Route {
  const course = getCourseById(courseId)
  if (!course) throw new Error('Course not found')
  const root = course.root
  const steps: Step[] = []
  const template = getTemplate(templateId)
  let idx = 0
  const push = (s: Omit<Step, 'id'>) => { steps.push({ id: `s${++idx}`, ...s }) }

  // 1. README
  const readme = listTop(root, e => e.isFile() && /^readme\.md$/i.test(e.name))[0]
  if (readme) push({ stage: template.stages[0], type: 'doc', title: `${template.stages[0]}：通读 ${readme.name}`, file: readme.name, note: '先抓定位、核心概念与最小示例' })

  // 2. docs 目录
  const docsDir = listTop(root, e => e.isDirectory() && /^docs?$/i.test(e.name))[0]
  if (docsDir) {
    const docFiles = collectFiles(join(root, docsDir.name), f => /\.(md|rst)$/i.test(f.name) && !SKIP_DOC_NAME.test(f.name), 3, 10)
    docFiles
      .map(f => toRel(root, f))
      .sort((a, b) => a.localeCompare(b))
      .forEach(f => push({ stage: template.stages[1], type: 'doc', title: `${template.stages[1]}：${f.split('/').pop()}`, file: f, note: '' }))
  }

  // 3. examples（hello/basic 在前，multi/tool/rag 在后）
  const exDir = listTop(root, e => e.isDirectory() && /^(examples?|samples?|cookbook)$/i.test(e.name))[0]
  if (exDir) {
    const exFiles = collectFiles(join(root, exDir.name), f => /\.(py|go|js|ts)$/i.test(f.name), 3, 20)
    const sortKey = (p: string) => (/hello|intro|basic|quick|minimal|first/i.test(p) ? 0 : /tool|structured|multi|rag|plan/i.test(p) ? 2 : 1)
    exFiles
      .map(f => toRel(root, f))
      .sort((a, b) => sortKey(a) - sortKey(b) || a.localeCompare(b))
      .slice(0, 8)
      .forEach(f => push({ stage: template.stages[4], type: 'file', title: `${template.stages[4]}：${f.split('/').pop()}`, file: f, note: '先跑通再读' }))
  }

  // 4. 核心源码（第一个命中且非空的核心目录；顶层无文件时下降一层，如 src/<pkg>/ 布局）
  for (const coreName of CORE_DIRS) {
    let coreDir = join(root, coreName)
    if (!existsSync(coreDir)) continue
    let coreFiles = listTop(coreDir, e => e.isFile() && /\.(py|go|ts|js)$/i.test(e.name))
    if (coreFiles.length === 0) {
      for (const sub of listTop(coreDir, e => e.isDirectory())) {
        const subFiles = listTop(join(coreDir, sub.name), e => e.isFile() && /\.(py|go|ts|js)$/i.test(e.name))
        if (subFiles.length > 0) { coreDir = join(coreDir, sub.name); coreFiles = subFiles; break }
      }
    }
    coreFiles = coreFiles
      .sort((a, b) => coreFileRank(a.name) - coreFileRank(b.name) || a.name.localeCompare(b.name))
      .slice(0, 6)
    for (const f of coreFiles) {
      push({
        stage: template.stages[3],
        type: 'file',
        title: `${template.stages[3]}：${f.name}`,
        file: toRel(root, join(coreDir, f.name)),
        note: '配合 AI 讲解读主流程'
      })
    }
    if (coreFiles.length > 0) break
  }

  // 5. 收尾检查点
  push({ stage: template.stages[5], type: 'checkpoint', title: `${template.stages[5]}：能否向外行讲清核心抽象？`, note: '自问自答，写笔记' })

  if (steps.length === 0) {
    push({ stage: template.stages[0], type: 'checkpoint', title: '空路线：请手动添加步骤或导入 md 指南' })
  }

  return saveRoute(courseId, { name: name || suggestRouteName(template, steps), steps: fillTemplate(steps, template), templateId: template.id })
}

function coreFileRank(name: string): number {
  const n = name.toLowerCase()
  if (/agent|graph|chain|model|main|index/.test(n)) return 0
  if (/test|setup|version|conftest/.test(n)) return 2
  return 1
}

function toRel(root: string, p: string): string {
  return relative(root, p).replace(/\\/g, '/')
}

function collectFiles(dir: string, filter: (e: any) => boolean, maxDepth: number, cap: number, depth = 0): string[] {
  if (depth > maxDepth || cap <= 0) return []
  const out: string[] = []
  let entries: any[] = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (IGNORE_TOP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...collectFiles(p, filter, maxDepth, cap - out.length, depth + 1))
    else if (filter(e)) out.push(p)
    if (out.length >= cap) break
  }
  return out
}

// ---------- FR-10② Markdown 导入 ----------

/** 课程内全量文件索引（相对路径），供 AI/导入的坏路径修复（大小写、丢前缀、只给文件名） */
interface FileIndex { paths: string[]; byLower: Map<string, string>; byBase: Map<string, string[]> }

function buildFileIndex(root: string): FileIndex {
  const paths: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || paths.length > 5000) return
    let entries: any[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (IGNORE_TOP.has(e.name) || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else paths.push(toRel(root, p))
    }
  }
  walk(root, 0)
  const byLower = new Map<string, string>()
  const byBase = new Map<string, string[]>()
  for (const p of paths) {
    byLower.set(p.toLowerCase(), p)
    const base = p.split('/').pop()!.toLowerCase()
    if (!byBase.has(base)) byBase.set(base, [])
    byBase.get(base)!.push(p)
  }
  return { paths, byLower, byBase }
}

/** 把模型/文档给出的坏路径修成真实相对路径；修不动返回 null（调用方降级处理，不静默丢弃） */
function repairFilePath(raw: string, index: FileIndex): string | null {
  const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  const lower = norm.toLowerCase()
  if (!lower) return null
  const exact = index.byLower.get(lower)
  if (exact) return exact
  const suffixHits = index.paths.filter(p => p.toLowerCase().endsWith('/' + lower))
  if (suffixHits.length === 1) return suffixHits[0]
  const base = lower.split('/').pop()!
  const baseHits = index.byBase.get(base) || []
  if (baseHits.length === 1) return baseHits[0]
  if (baseHits.length > 1) {
    // 用坏路径的上一级目录段做消歧（如 agents/models.py → 命中 agents/ 下的同名文件）
    const prevSeg = lower.split('/').slice(-2, -1)[0]
    if (prevSeg) {
      const better = baseHits.filter(p => p.toLowerCase().includes('/' + prevSeg + '/'))
      if (better.length === 1) return better[0]
    }
  }
  return null
}

/** 候选文件摘要（路径|角色|行数|重要度）：给低级模型一份「只能从这里选」的填空清单 */
function buildCourseDigest(courseId: string): string {
  const flat = getFlatFiles(courseId)
  const noise = /(^|\/)(node_modules|dist|build|__pycache__|\.venv|venv|assets|static)\//
  const cand = flat.filter(f => /\.(py|go|ts|js|tsx|jsx|md|rst|toml|json|ya?ml|mod|sh)$/i.test(f.path) && !noise.test(f.path) && !f.path.startsWith('.'))
  const weight = (f: typeof cand[number]) =>
    (f.score ?? 0) + (f.role === 'entry' ? 50 : 0) + (f.role === 'core' ? 30 : 0) + (f.role === 'example' ? 15 : 0) + (f.role === 'doc' ? 8 : 0)
  const picked = cand.sort((a, b) => weight(b) - weight(a) || (a.lines ?? 0) - (b.lines ?? 0)).slice(0, 90)
  const dirs = new Map<string, number>()
  for (const f of flat) {
    const i = f.path.indexOf('/')
    if (i > 0) dirs.set(f.path.slice(0, i), (dirs.get(f.path.slice(0, i)) || 0) + 1)
  }
  const dirLine = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => `${d}/(${n})`).join(' ')
  return `顶层目录: ${dirLine || '(平铺)'}\n候选文件（路径|角色|行数|重要度）:\n${picked.map(f => `${f.path}|${f.role || '-'}|${f.lines ?? '-'}|${f.score ?? '-'}`).join('\n')}`
}

export function importMdRoute(body: { courseId: string; mdPath: string; routeName?: string; section?: string; templateId?: RouteTemplateId }): Route & { warnings: string[] } {
  const course = getCourseById(body.courseId)
  if (!course) throw new Error('Course not found')

  const mdPath = resolve(resolveFsPath(body.mdPath))
  // 允许读取：课程根内 或 任一学习根路径内（指南 md 常散放在根目录）；容器内按映射路径比较
  const allowed = [course.root, ...getRoots().map((r: any) => resolveFsPath(r.path))]
  if (!allowed.some(p => mdPath.toLowerCase().startsWith(resolve(p).toLowerCase()))) {
    throw new Error('md 路径必须位于学习根路径或课程目录内')
  }
  if (!existsSync(mdPath)) throw new Error('文件不存在')

  let mdContent = readFileSync(mdPath, 'utf8')
  if (body.section) {
    mdContent = extractSection(mdContent, body.section)
  }

  const { steps: parsedSteps, warnings } = parseMdToSteps(mdContent, course.root)
  const template = getTemplate(body.templateId)
  const steps = fillTemplate(parsedSteps, template)
  const autoName = body.section ? `导入 · ${body.section}` : `导入 · ${template.name}`
  const route = saveRoute(body.courseId, { name: body.routeName || autoName, steps, templateId: template.id })
  return { ...route, warnings }
}

export function fillTemplate(steps: Step[], template: RouteTemplate): Step[] {
  const stageNames = new Set(template.stages)
  const usedSlots = new Set<string>()
  const slotFor = (step: Step, index: number) => {
    const explicit = step.slot && template.slots.find(slot => slot.id === step.slot)
    if (explicit && !usedSlots.has(explicit.id)) return explicit
    const byStage = step.stage && template.slots.find(slot => slot.stage === step.stage && slot.type === step.type && !usedSlots.has(slot.id))
    if (byStage) return byStage
    const byType = template.slots.find(slot => slot.type === step.type && !usedSlots.has(slot.id))
    if (byType) return byType
    const stageIndex = step.type === 'checkpoint' ? template.stages.length - 1 : step.type === 'test' ? Math.min(4, template.stages.length - 2) : Math.min(index, template.stages.length - 2)
    return template.slots.find(slot => slot.stage === template.stages[stageIndex] && !usedSlots.has(slot.id))
  }
  const filled = steps.map((step, index) => {
    const slot = slotFor(step, index)
    if (slot) usedSlots.add(slot.id)
    const stage = slot?.stage || (step.stage && stageNames.has(step.stage) ? step.stage : template.stages[Math.min(index, template.stages.length - 1)])
    // 标题前缀只保留一层：槽位改判阶段时替换旧前缀，不叠罗汉（「骨架：核心模块：x」→「骨架：x」）
    let title = step.title
    const m = title.match(/^([^：]{1,10})：([\s\S]*)$/)
    if (m && stageNames.has(m[1]) && m[1] !== stage) title = m[2]
    title = title.startsWith(`${stage}：`) ? title : `${stage}：${title}`
    return { ...step, stage, title, slot: slot?.id || step.slot }
  })
  for (const slot of template.slots) {
    if (!slot.required || usedSlots.has(slot.id)) continue
    filled.push({
      id: `template-${slot.id}`,
      type: slot.type,
      stage: slot.stage,
      slot: slot.id,
      title: `${slot.stage}：待填充 · ${slot.label}`,
      note: `模板必填槽位「${slot.label}」尚未映射到真实内容，请在步骤编辑器中补充。`
    })
  }
  // 按模板阶段顺序稳定重排：树的分组与「下一步」推荐都跟随学习顺序
  const stageOrder = new Map(template.stages.map((s, i) => [s, i]))
  return filled
    .map((step, i) => ({ step, i }))
    .sort((a, b) => (stageOrder.get(a.step.stage || '') ?? 99) - (stageOrder.get(b.step.stage || '') ?? 99) || a.i - b.i)
    .map(x => x.step)
}

function extractSection(content: string, sectionTitle: string): string {
  const lines = content.split('\n')
  const start = lines.findIndex(l => l.includes(sectionTitle) && /^#{1,6}\s/.test(l.trim()))
  if (start === -1) return content
  const level = (lines[start].match(/^#+/) || ['#'])[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/)
    if (m && m[1].length <= level) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

export function parseMdToSteps(content: string, courseRoot: string): { steps: Step[]; warnings: string[] } {
  const steps: Step[] = []
  const warnings: string[] = []
  const lines = content.split('\n')
  let current: { title: string; type: Step['type']; file?: string; range?: [number, number]; noteBuf: string } | null = null
  let idx = 0
  let totalRefs = 0
  let resolvedRefs = 0
  const fileIndex = buildFileIndex(courseRoot)

  const flush = () => {
    if (!current) return
    if (current.file) {
      steps.push({ id: `s${++idx}`, type: current.type, title: current.title, file: current.file, range: current.range, note: current.noteBuf.slice(0, 400) })
    } else if (current.type === 'doc') {
      // 未映射到文件的切片 → 纯 doc 步骤
      steps.push({ id: `s${++idx}`, type: 'doc', title: current.title, note: current.noteBuf.slice(0, 400) })
    }
    current = null
  }

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      flush()
      current = { title: heading[2].trim(), type: 'doc', noteBuf: '' }
      continue
    }
    if (!current) continue

    const ref = line.match(/[`*（(]?\s*([\w\-./\\]+\.(?:py|js|ts|tsx|go|md|json|yaml|yml))\s*(?:[:：]\s*L?(\d+)\s*[-~—]\s*L?(\d+)|[:：]\s*L?(\d+))?/i)
    if (ref) {
      totalRefs++
      const rel = ref[1].replace(/\\/g, '/')
      const candidates = [join(courseRoot, rel), join(courseRoot, 'src', rel), join(courseRoot, rel.replace(/^.*?\//, ''))]
      let hit = candidates.find(c => existsSync(c))
      // 直接路径未命中 → 全库模糊修复（大小写/丢前缀/只给文件名）
      if (!hit) {
        const repaired = repairFilePath(rel, fileIndex)
        if (repaired) hit = join(courseRoot, repaired)
      }
      if (hit) {
        resolvedRefs++
        current.file = toRel(courseRoot, hit)
        current.type = extname(hit).toLowerCase() === '.md' ? 'doc' : 'file'
        if (ref[2] && ref[3]) current.range = [parseInt(ref[2]), parseInt(ref[3])]
        else if (ref[4]) current.range = [parseInt(ref[4]), parseInt(ref[4]) + 60]
      } else {
        // 跨仓库引用（如 Phase2 章节同时讲多个仓库）：降级为要点说明，不让整条导入失败
        const sibling = join(courseRoot, '..', rel)
        if (existsSync(sibling)) {
          current.noteBuf += `> 参考（其他仓库）: ${rel}\n`
        } else {
          warnings.push(`未定位到文件：${rel}`)
        }
      }
    }
    if (!/^\s*$/.test(line) && current.noteBuf.length < 400) {
      current.noteBuf += line.trim() + '\n'
    }
  }
  flush()

  // 映射率检查（FR-10②：≥70% 判成功）
  if (totalRefs > 0) {
    const rate = resolvedRefs / totalRefs
    if (rate < 0.7) warnings.unshift(`路径映射率 ${Math.round(rate * 100)}%（<70%），请人工核对步骤`)
  }
  if (steps.length === 0) {
    steps.push({ id: 's1', type: 'checkpoint', title: '导入结果为空：请检查 md 结构', note: content.slice(0, 300) })
  }
  return { steps, warnings }
}

// ---------- FR-29 AI 路线草案（模板填空 + 候选清单 + 路径修复） ----------

export async function generateAiRouteDraft(body: { courseId: string; prompt?: string; name?: string; templateId?: RouteTemplateId }): Promise<{ steps: Step[]; warnings: string[]; error?: string }> {
  const course = getCourseById(body.courseId)
  if (!course) throw new Error('Course not found')

  const template = getTemplate(body.templateId)
  const fileIndex = buildFileIndex(course.root)
  const digest = buildCourseDigest(body.courseId)
  const readme = getReadmeHead(course.root)
  const result = await aiGenerateRoute({
    courseId: body.courseId,
    structure: listTop(course.root).map(e => ({ name: e.name, dir: e.isDirectory() })),
    prompt: body.prompt,
    readme,
    digest,
    templateId: template.id,
    templateStages: template.stages,
    templateSlots: template.slots
  })

  if (result.error) return { steps: [], warnings: [], error: result.error }

  const warnings: string[] = []
  const steps: Step[] = []
  ;(result.steps || []).forEach((s: any, i: number) => {
    let type = (['file', 'doc', 'test', 'checkpoint'].includes(s.type) ? s.type : 'file') as Step['type']
    let file: string | undefined
    if (s.file && typeof s.file === 'string') {
      const repaired = repairFilePath(s.file, fileIndex)
      if (repaired) {
        file = repaired
        if (repaired !== s.file.replace(/\\/g, '/').replace(/^\.\//, '')) warnings.push(`路径已自动修正：${s.file} → ${repaired}`)
      } else {
        // 引用的文件不存在：保留学习意图，降级为检查点（低级模型常编路径，剔除会让路线缺角）
        warnings.push(`未找到文件「${s.file}」，步骤已降级为检查点`)
        type = 'checkpoint'
        s.note = `⚠ 原引用 ${s.file} 不在仓库中。${s.note || ''}`
      }
    }
    steps.push({
      id: s.id || `s${i + 1}`,
      type,
      title: String(s.title || `步骤 ${i + 1}`),
      file,
      range: Array.isArray(s.range) && s.range.length === 2 && Number.isFinite(Number(s.range[0])) && Number.isFinite(Number(s.range[1]))
        ? [Number(s.range[0]), Number(s.range[1])] as [number, number]
        : undefined,
      note: s.note ? String(s.note) : undefined,
      stage: s.stage ? String(s.stage) : undefined,
      slot: s.slot ? String(s.slot) : undefined
    })
  })

  return { steps: fillTemplate(steps, template), warnings }
}

function getReadmeHead(root: string): string {
  try { return readFileSync(join(root, 'README.md'), 'utf8').split('\n').slice(0, 20).join('\n') } catch { return '' }
}
