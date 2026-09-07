import { getAiConfig, getSettings } from './settings.js'
import { getCourseById } from './scanner.js'
import { readFileSync, existsSync } from 'fs'
import { join, resolve, dirname, basename } from 'path'

const MAX_CONTEXT_TOKENS = 6000

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

function truncateContext(text: string, maxTokens: number): string {
  const estTokens = estimateTokens(text)
  if (estTokens <= maxTokens) return text
  const ratio = maxTokens / estTokens
  const newLength = Math.floor(text.length * ratio * 0.9)
  return text.slice(0, newLength) + '\n...[已截断]...'
}

// FR-27 上下文构建器：同文件 import 的模块优先，≤3 个相关文件
function buildImportContext(courseRoot: string, relFile: string): string {
  const parts: string[] = []
  let main = ''
  try { main = readFileSync(resolve(courseRoot, relFile), 'utf8') } catch { return '' }

  const imports = new Set<string>()
  const patterns = [
    /(?:from|import)\s+[\w.\s{}]*?\bfrom\b\s*['"]([^'"]+)['"]/g, // js/ts
    /^\s*import\s+([\w.]+)/gm,                                    // python
    /^\s*from\s+([\w.]+)\s+import/gm                              // python from
  ]
  for (const p of patterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(main))) imports.add(m[1])
  }

  const selfDir = dirname(resolve(courseRoot, relFile))
  const candidates: string[] = []
  for (const imp of imports) {
    const base = imp.replace(/\./g, '/')
    for (const ext of ['.py', '.ts', '.js', '.go', '/index.ts', '/index.js']) {
      const direct = resolve(selfDir, base + ext)
      const rel = resolve(courseRoot, base + ext)
      if (existsSync(direct)) candidates.push(direct)
      else if (existsSync(rel)) candidates.push(rel)
    }
  }

  for (const c of candidates.slice(0, 3)) {
    try {
      const rel = c.startsWith(courseRoot) ? c.slice(courseRoot.length + 1) : basename(c)
      parts.push(`--- 相关文件 ${rel}（截取前 60 行）---\n` + readFileSync(c, 'utf8').split('\n').slice(0, 60).join('\n'))
    } catch {}
  }
  return parts.join('\n\n')
}

export async function aiExplain(body: {
  courseId: string
  file: string
  selection: string
  context?: string
  stepNote?: string
}): Promise<{ content: string; error?: string }> {
  const ai = getAiConfig()
  if (!ai?.apiKey) return { content: '', error: 'AI 未配置：请到设置页填写 API Key' }

  const course = getCourseById(body.courseId)
  if (!course) return { content: '', error: '课程不存在' }

  const readmeSummary = course.scan_meta?.readmeSummary || ''
  const importCtx = body.context || buildImportContext(course.root, body.file)

  const prompt = `你是代码讲解助手。请解释选中的代码片段，结合上下文。

当前文件: ${body.file}
步骤要点: ${body.stepNote || '无'}

仓库 README 摘要:
${readmeSummary}

相关上下文:
${truncateContext(importCtx || '无', 3000)}

选中代码:
\`\`\`
${body.selection}
\`\`\`

请用中文回答，包含：
1. 这段代码的作用
2. 关键逻辑点
3. 可能的注意事项/易错点`

  return callAi(ai, [{ role: 'user', content: prompt }])
}

export async function aiChat(body: {
  courseId: string
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>
  routeContext?: { stepTitle: string; stepNote: string; file?: string }
  identity?: 'teacher' | 'operator' | 'analyst' | 'tester'
}): Promise<{ content: string; error?: string }> {
  const ai = getAiConfig()
  if (!ai?.apiKey) return { content: '', error: 'AI 未配置：请到设置页填写 API Key' }

  const identity = body.identity || ai.identity || 'teacher'
  // 四个专业身份模板：角色 → 方法论 → 输出契约 → 边界，低级模型也照此执行
  const identityPrompt: Record<string, string> = {
    teacher: `你是「资深老师」：有十年经验的代码阅读教练，擅长把陌生仓库讲成人人能懂的心智模型。
方法：先给一句话定位（这东西是什么、为谁解决什么问题）→ 建立心智模型（用类比把新概念挂到学习者已有知识上）→ 拆最小例子（能跑、能改、能观察）→ 留一个可执行的练习。
输出契约：① 结论先行 ② 每个术语首次出现必须给中文解释 ③ 不跳步：默认学习者没读过本项目源码 ④ 结尾给「下一步做什么」。
边界：不空泛鼓励、不堆术语；学习者问的是 A 就先答 A，再补背景。`,
    operator: `你是「专业助手」：像资深工程师结对一样，先给结论和可执行步骤，再说明影响与风险。
方法：把问题改写成可执行任务 → 给出最短操作路径（命令/代码/点击顺序）→ 标注副作用、风险与需要用户确认的点。
输出契约：① 结论/步骤用编号列表，可直接照做 ② 每步说明「为什么这样做」③ 有破坏性操作先警告再给方案 ④ 不确定就明说并给验证方法。
边界：不替用户做决定；不输出无法执行的伪代码。`,
    analyst: `你是「分析专家」：以证据为核心的代码考古学家，区分事实、推断与未知。
方法：先列已知事实（引用文件路径与行号）→ 给出推断链（因为 A+B，所以 C）→ 明确未知项与获取方式 → 输出权衡与替代方案对比。
输出契约：① 每条结论标注证据来源（file:line）② 事实/推断/未知三色分明 ③ 对比方案用表格化维度（成本、风险、收益）④ 结论可被反驳：给出「如果 X 则结论变 Y」。
边界：没有证据不下结论；不臆测作者意图。`,
    tester: `你是「测试与问答专家」：QA 视角的验证机器，一切回答都要能转成可执行的验证动作。
方法：把问题转成断言 → 设计最小复现步骤 → 覆盖边界（空输入/超大输入/异常路径/并发）→ 给出「怎么算通过」的判据。
输出契约：① 每个结论附带验证方法（命令、测试用例、观察点）② 用例按「正常路径→边界→异常」排序 ③ 明确预期输出与实际输出如何比对 ④ 指出当前代码最可能出 bug 的位置。
边界：不给无法验证的说法；不省略前置条件。`
  }
  const systemPrompt = `${identityPrompt[identity]}\n\n当前场景：你在帮助用户学习本地代码仓库。${body.routeContext ? `当前学习步骤: ${body.routeContext.stepTitle}\n要点: ${body.routeContext.stepNote}\n文件: ${body.routeContext.file || '无'}` : ''}\n始终用简体中文回答，代码标识符保持原文，术语准确，避免空泛鼓励。`

  const messages = body.messages
    .filter(m => m.role !== 'system')
    .slice(-10)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: truncateContext(m.content, 2000) }))

  return callAi(ai, messages, systemPrompt)
}

export async function aiGenerateRoute(body: {
  courseId: string
  structure: any
  prompt?: string
  readme?: string
  digest?: string
  templateId?: string
  templateStages?: readonly string[]
  templateSlots?: readonly { id: string; stage: string; type: string; label: string; required: boolean; guide?: string }[]
}): Promise<{ steps: any[]; error?: string }> {
  const ai = getAiConfig()
  if (!ai?.apiKey) return { steps: [], error: 'AI 未配置：请到设置页填写 API Key' }

  const course = getCourseById(body.courseId)
  if (!course) return { steps: [], error: '课程不存在' }

  const stages = body.templateStages || ['定位', '概念', '入口', '核心', '验证', '复盘']
  const slotTable = (body.templateSlots || [])
    .map(s => `- slot=${s.id} | 阶段=${s.stage} | 类型=${s.type} | 名称=${s.label} | 必填=${s.required ? '是' : '否'} | 填法=${s.guide || '按名称选择最匹配的真实文件'}`)
    .join('\n')
  const prompt = `任务：为仓库「${course.slug}」按模板「${body.templateId || 'codebase-onboarding'}」填空，生成一条学习路线。这是槽位填空而不是自由创作：阶段和槽位已固定，你只需要为每个槽位挑选真实文件并写一句要点。

模板阶段（顺序固定）：${stages.join(' → ')}

槽位表（每个必填槽位输出恰好一个步骤；slot 字段必须逐字使用表中的 id）：
${slotTable}

仓库顶层结构: ${JSON.stringify(body.structure)}

候选文件清单（file 只能逐字复制这里的相对路径，禁止编造或改写大小写；清单里没有的文件一律不引用）:
${(body.digest || '').slice(0, 6000)}

README 摘要:
${(body.readme || '').slice(0, 1200)}
${body.prompt ? `\n用户附加要求：${body.prompt}\n` : ''}
输出 JSON 数组，每个元素字段：
{"slot":"槽位id","stage":"阶段名(照抄)","type":"file|doc|test|checkpoint","title":"≤20字的中文步骤名","file":"候选清单中的路径(可省略)","range":[起,止](可选,不确定就不写),"note":"一句话阅读要点"}

硬性规则：
1. 必填槽位各出一个步骤；可选槽位没有合适文件就跳过。
2. file 必须逐字来自候选清单；checkpoint 不需要 file。
3. 同一文件不要在多个步骤重复出现。
4. 只输出 JSON 数组本体：不要解释、不要 markdown 围栏、不要尾逗号。`

  const result = await callAi(ai, [{ role: 'user', content: prompt }], '你是代码学习路线规划器，严格按用户给出的槽位表填空，绝不虚构文件路径。')
  if (result.error) return { steps: [], error: result.error }

  try {
    const steps = parseJsonLoose(result.content)
    if (!Array.isArray(steps)) return { steps: [], error: 'AI 返回格式错误（非数组）' }
    return { steps }
  } catch {
    return { steps: [], error: 'AI 返回格式错误（JSON 解析失败）' }
  }
}

// ---------- FR-29 教程/注释翻译（增量接口，不改既有 AI 契约） ----------
export interface TranslateRequest {
  readonly text: string
  readonly targetLang: 'zh'
  readonly courseId?: string
  readonly context?: string   // 内容语境提示（如 "Python 源码注释" / "Markdown 教程"），提升机翻术语准确度
}

export type TranslateResult = { readonly content: string; readonly error?: string }

// 同步边界解析：在 wrap() 同步回调内完成，参数错误抛出 → HTTP 400；
// 不触碰 provider、不读文件、不写日志；callAi 的错误前缀与既有 AI 功能一致。
export function parseTranslateRequest(input: unknown): TranslateRequest {
  if (typeof input !== 'object' || input === null) {
    throw new Error('请求体必须是 JSON 对象')
  }
  const body = input as Record<string, unknown>

  const text = body.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('text 必须是非空字符串')
  }

  const targetLang = body.targetLang === undefined ? 'zh' : body.targetLang
  if (targetLang !== 'zh') {
    throw new Error("targetLang 目前仅支持 'zh'")
  }

  const courseId = body.courseId
  if (courseId !== undefined && (typeof courseId !== 'string' || courseId.trim() === '')) {
    throw new Error('courseId 必须是非空字符串')
  }

  const context = body.context
  if (context !== undefined && (typeof context !== 'string' || context.trim() === '')) {
    throw new Error('context 必须是非空字符串')
  }

  // 复用既有上下文预算（不静默截断：翻译必须保留完整段落与结构）
  const tokenEstimate = estimateTokens(text)
  if (tokenEstimate > MAX_CONTEXT_TOKENS) {
    throw new Error(`text 过长：约 ${tokenEstimate} tokens（上限 ${MAX_CONTEXT_TOKENS}），请缩短后重试`)
  }

  return {
    text,
    targetLang,
    courseId: typeof courseId === 'string' ? courseId : undefined,
    context: typeof context === 'string' ? context : undefined
  }
}

// 系统提示：只输出译文、保留 Markdown 结构；user 层仅含请求 text 与数据分隔符。
const TRANSLATE_SYSTEM = `你是资深软件工程文献译者（母语中文，熟读 Python/Go/JS 生态官方文档），负责把英文教程与代码注释译成准确、自然、可执行的简体中文。
翻译原则：
1. 先理解再动笔：按整句语义翻译，禁止逐词硬译；中文语序自然，短句保持短，祈使句保持动作导向（"运行/安装/注意"式），消灭翻译腔（"被…所…""进行一个…的操作"这类结构一律重写）。
2. 术语用行业通行译法：repository=仓库，package=包，dependency=依赖，runtime=运行时，entry point=入口点，callback=回调，middleware=中间件，fail fast=快速失败，fallback=兜底，patch=补丁，deploy=部署，orchestrate=编排；首次出现的专有概念用「中文（英文）」格式，之后直接用中文。
3. 保持原样不译：API、SDK、CLI、HTTP、JSON 等缩写，函数名/类名/变量名/文件名/命令行参数，代码围栏内的代码；围栏内的英文注释可译为中文注释但必须保持代码结构。
4. 保留一切 Markdown 结构：标题层级、列表顺序、链接 URL、行内代码、HTML 标签、占位符、数字与换行空行。
5. 语气与上下文一致：教程用引导式第二人称，注释用陈述式，报错信息保持原意。
只输出译文本身：不输出原文、不解释、不加前后缀、不用代码围栏包裹整段译文。`

// 只接收已解析值；无 Key 早退且不发请求；courseId 仅校验存在，不读取课程文件或注入 README。
export async function aiTranslate(request: TranslateRequest): Promise<TranslateResult> {
  const ai = getAiConfig()
  if (!ai?.apiKey) return { content: '', error: 'AI 未配置：请到设置页填写 API Key' }

  if (request.courseId !== undefined && !getCourseById(request.courseId)) {
    return { content: '', error: '课程不存在' }
  }

  const contextLine = request.context ? `内容语境：${request.context}（按该文体选择译法）。\n` : ''
  const userContent = `${contextLine}---- 待翻译内容开始 ----\n${request.text}\n---- 待翻译内容结束 ----`
  return callAi(ai, [{ role: 'user', content: userContent }], TRANSLATE_SYSTEM)
}

// ---------- 批量翻译：一次请求译完整个文件的注释块（浏览器翻译式整页渲染的服务端支撑） ----------
export interface TranslateBatchRequest {
  readonly blocks: string[]
  readonly context?: string
  readonly courseId?: string
}

const BATCH_SYSTEM = `${TRANSLATE_SYSTEM}

批量模式补充规则：输入是若干编号行（[1] 原文 [2] 原文 …），每行一个独立的代码注释或短语。
对每一行输出 "[编号] 译文"，行数与编号必须与输入完全一致，逐行对应，不合并不拆分，不输出任何额外文字。
注释体译文务必精炼（不超过原文长度的 1.5 倍），保留行内代码与标识符原样。`

export async function aiTranslateBatch(request: TranslateBatchRequest): Promise<{ contents: string[]; error?: string }> {
  const ai = getAiConfig()
  if (!ai?.apiKey) return { contents: [], error: 'AI 未配置：请到设置页填写 API Key' }
  const blocks = (request.blocks || []).map(b => String(b).replace(/\s+/g, ' ').trim()).filter(b => b.length > 0)
  if (blocks.length === 0) return { contents: [], error: 'blocks 为空' }
  if (blocks.length > 120) return { contents: [], error: '单次最多 120 个注释块，请分段翻译' }

  const numbered = blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n')
  const contextLine = request.context ? `内容语境：${request.context}。\n` : ''
  // 批量输出远长于单条：按块数放大输出预算（上限 8192 兼容常见中转），避免译文被 max_tokens 截断
  const result = await callAi(ai, [{ role: 'user', content: `${contextLine}${numbered}` }], BATCH_SYSTEM, { maxTokens: Math.min(8192, Math.max(2048, blocks.length * 80)) })
  if (result.error) return { contents: [], error: result.error }

  // 解析 [n] 译文 行；模型偶尔丢编号——按顺序兜底对齐
  const byIndex = new Map<number, string>()
  const loose: string[] = []
  for (const line of result.content.split('\n')) {
    const m = line.match(/^\s*\[?(\d{1,3})\]?\s*[.、:：]?\s*(.+)$/)
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= blocks.length && !byIndex.has(Number(m[1]))) {
      byIndex.set(Number(m[1]), m[2].trim())
    } else if (line.trim() && !/^\s*```/.test(line)) {
      loose.push(line.trim())
    }
  }
  let cursor = 0
  const contents = blocks.map((_, i) => {
    const hit = byIndex.get(i + 1)
    if (hit) return hit
    return loose[cursor++] || ''
  })
  return { contents }
}

export function parseTranslateBatchRequest(input: unknown): TranslateBatchRequest {
  if (typeof input !== 'object' || input === null) throw new Error('请求体必须是 JSON 对象')
  const body = input as Record<string, unknown>
  if (!Array.isArray(body.blocks) || body.blocks.length === 0) throw new Error('blocks 必须是非空字符串数组')
  const blocks = body.blocks.map(b => {
    if (typeof b !== 'string' || !b.trim()) throw new Error('blocks 元素必须是非空字符串')
    if (b.length > 1200) throw new Error('单个注释块不能超过 1200 字符')
    return b
  })
  const total = blocks.reduce((a, b) => a + b.length, 0)
  if (total > 12000) throw new Error(`本批内容过长（${total} 字符 > 12000），请分段翻译`)
  if (body.courseId !== undefined && (typeof body.courseId !== 'string' || !body.courseId.trim())) throw new Error('courseId 必须是非空字符串')
  if (body.context !== undefined && (typeof body.context !== 'string' || !body.context.trim())) throw new Error('context 必须是非空字符串')
  return {
    blocks,
    context: typeof body.context === 'string' ? body.context : undefined,
    courseId: typeof body.courseId === 'string' ? body.courseId : undefined
  }
}

// AI 常见把 JSON 包在 ```json 围栏里 → 剥离后再解析
function parseJsonLoose(text: string): any {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : trimmed
  const start = Math.min(...['[', '{'].map(c => {
    const i = body.indexOf(c)
    return i === -1 ? Infinity : i
  }))
  if (start !== Infinity) {
    const end = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'))
    return JSON.parse(body.slice(start, end + 1))
  }
  return JSON.parse(body)
}

// FR-26 连通测试
export async function aiTestConnection(): Promise<{ ok: boolean; message: string; model?: string }> {
  const ai = getAiConfig()
  if (!ai?.apiKey) return { ok: false, message: '未配置 API Key' }
  const result = await callAi(ai, [{ role: 'user', content: '回复"ok"两个字母即可。' }])
  if (result.error) return { ok: false, message: result.error }
  return { ok: true, message: `连接成功，模型 ${ai.model} 可用`, model: ai.model }
}

async function callAi(ai: any, messages: any[], system?: string, opts?: { maxTokens?: number }): Promise<{ content: string; error?: string }> {
  const providerDefaults: Record<string, string> = {
    deepseek: 'https://api.deepseek.com',
    opencode: 'https://opencode.ai/zen/v1',
    compatible: 'https://api.openai.com/v1'
  }
  const baseURL = (ai.baseURL || providerDefaults[ai.provider] || 'https://api.anthropic.com').replace(/\/+$/, '')
  const isOpenAI = ['openai', 'deepseek', 'opencode', 'compatible'].includes(ai.provider) || baseURL.includes('openai') || baseURL.includes('deepseek') || baseURL.includes('opencode') || baseURL.includes('azure')
  const maxTokens = Number(opts?.maxTokens) > 0 ? Number(opts?.maxTokens) : (Number(ai.maxTokens) > 0 ? Number(ai.maxTokens) : 2048)
  const temperature = Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2
  const thinking = ai.thinking === 'low' || ai.thinking === 'high' ? ai.thinking : 'medium'

  try {
    let response: Response
    if (isOpenAI) {
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages
      const post = (withReasoning: boolean) => fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ai.apiKey}` },
        body: JSON.stringify({
          model: ai.model,
          messages: msgs,
          max_tokens: maxTokens,
          temperature,
          ...(withReasoning ? { reasoning_effort: thinking } : {})
        })
      })
      response = await post(true)
      // 部分兼容端点（DeepSeek 官方、老中转）不认识 reasoning_effort → 400 时去掉该参数重试一次
      if (!response.ok && response.status === 400) {
        const errText = await response.text().catch(() => '')
        if (/reasoning_effort|reasoning/i.test(errText)) {
          response = await post(false)
        } else {
          return { content: '', error: `API 错误: ${response.status} ${errText.slice(0, 500)}` }
        }
      }
    } else {
      // Anthropic 风格：思考强度 high 时开启扩展思考（预算 < max_tokens），其余不带 thinking 参数
      const thinkingBudget = thinking === 'high' ? Math.min(8192, Math.max(1024, Math.floor(maxTokens / 2))) : 0
      response = await fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ai.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: ai.model,
          ...(system ? { system } : {}),
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          max_tokens: maxTokens + thinkingBudget,
          temperature,
          ...(thinkingBudget > 0 ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } } : {})
        })
      })
    }

    if (!response.ok) {
      const err = (await response.text()).slice(0, 500)
      return { content: '', error: `API 错误: ${response.status} ${err}` }
    }

    const data: any = await response.json()
    const content = isOpenAI
      ? data.choices?.[0]?.message?.content
      : (Array.isArray(data.content) ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text || '').join('') : data.content?.text)
    return { content: content || '', error: content ? undefined : '空响应' }
  } catch (e: any) {
    return { content: '', error: `请求失败: ${e.message}` }
  }
}
