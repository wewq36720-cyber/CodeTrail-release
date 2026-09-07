import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import { api } from '../lib/api'
import type { Course, Route, Step, StepProgress, AiIdentity } from '../types'

export interface AiChatProps {
  variant: 'side' | 'rail'
  course: Course | undefined
  route: Route | undefined
  progress: Record<string, StepProgress>
  /** 带入的初始问题 */
  seed?: string
  /** side 形态：收起 / 展开为完整 AI 界面 */
  onClose?: () => void
  onExpand?: () => void
}

interface Msg { role: 'user' | 'assistant'; content: string }
interface Session { id: string; title: string; messages: Msg[]; ts: number }

const SESSIONS_KEY = 'ct-ai-sessions-v1'
const SESSIONS_LIMIT = 30
const IDENTITY_KEY = 'ct-ai-identity'

/** 四个专业身份模板：与服务端 aiChat 的 identity 一一对应，各自带开场建议 */
export const AI_IDENTITIES: Array<{ id: AiIdentity; icon: string; name: string; hint: string; suggestions: string[] }> = [
  { id: 'teacher', icon: '🎓', name: '资深老师', hint: '心智模型 → 例子 → 练习', suggestions: ['用心智模型解释这一步', '这个概念有没有生活化类比？', '给我一个能动手的小练习', '我基础薄弱，先讲前置知识'] },
  { id: 'operator', icon: '🛠️', name: '专业助手', hint: '结论 → 步骤 → 风险', suggestions: ['直接告诉我现在该做什么', '给出可执行的下一步操作', '这样做有什么风险和副作用？', '帮我列一份操作清单'] },
  { id: 'analyst', icon: '🔬', name: '分析专家', hint: '事实 → 推断 → 权衡', suggestions: ['这个设计的取舍是什么？', '对比两种实现方案的优劣', '这条结论的证据在哪几行？', '哪些是事实、哪些是你的推断？'] },
  { id: 'tester', icon: '🧪', name: '测试问答', hint: '复现 → 断言 → 边界', suggestions: ['这段代码怎么验证跑通了？', '给出三个边界用例', '最容易出 bug 的位置在哪？', '如何设计一个最小复现？'] }
]

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
function persist(list: Session[]) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, SESSIONS_LIMIT))) } catch { /* noop */ }
}
function newSession(): Session {
  return { id: `s-${Date.now()}`, title: '新会话', messages: [], ts: Date.now() }
}

/* AI 对话（双形态共用）：side = 主界面侧边栏代码助手；rail = AI 界面右栏对话区 */
export function AiChat({ variant, course, route, progress, seed, onClose, onExpand }: AiChatProps) {
  const [sessions, setSessions] = useState<Session[]>(loadSessions)
  const [activeId, setActiveId] = useState<string>(() => {
    const list = loadSessions()
    if (list.length) return list[0].id
    const s = newSession()
    persist([s])
    return s.id
  })
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [identity, setIdentity] = useState<AiIdentity>(() => {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY) as AiIdentity | null
      return raw && AI_IDENTITIES.some(i => i.id === raw) ? raw : 'teacher'
    } catch { return 'teacher' }
  })
  const identityMeta = AI_IDENTITIES.find(i => i.id === identity) || AI_IDENTITIES[0]
  useEffect(() => {
    try { localStorage.setItem(IDENTITY_KEY, identity) } catch { /* noop */ }
  }, [identity])
  const msgsRef = useRef<HTMLDivElement>(null)
  const seedUsed = useRef(false)

  // 当前步骤：进行中 → 第一个待办 → 第一个
  const currentStep: Step | undefined = useMemo(() => {
    const steps = route?.steps || []
    return steps.find(s => progress[s.id]?.status === 'doing')
      || steps.find(s => !progress[s.id] || progress[s.id].status === 'todo')
      || steps[0]
  }, [route, progress])

  useEffect(() => {
    if (seed && !seedUsed.current) { seedUsed.current = true; setInput(seed) }
  }, [seed])

  useEffect(() => {
    if (msgsRef.current) msgsRef.current.scrollTop = msgsRef.current.scrollHeight
  }, [sessions, loading])

  const active = sessions.find(s => s.id === activeId) || sessions[0]
  const messages = active?.messages || []

  function mutate(id: string, fn: (s: Session) => Session) {
    setSessions(prev => {
      const next = prev.map(s => (s.id === id ? fn(s) : s))
      persist(next)
      return next
    })
  }

  async function send() {
    const q = input.trim()
    if (!q || loading || !course || !active) return
    setInput('')
    const history: Msg[] = [...active.messages, { role: 'user', content: q }]
    mutate(active.id, s => ({
      ...s,
      title: s.messages.length === 0 ? q.slice(0, 20) : s.title,
      messages: history,
      ts: Date.now()
    }))
    setLoading(true)
    try {
      const res = await api.aiChat({
        courseId: course.id,
        messages: history,
        identity,
        routeContext: currentStep
          ? { stepTitle: currentStep.title, stepNote: currentStep.note || '', file: currentStep.file }
          : undefined
      })
      mutate(active.id, s => ({ ...s, messages: [...history, { role: 'assistant' as const, content: res.content || res.error || '无响应' }], ts: Date.now() }))
    } catch (e: any) {
      mutate(active.id, s => ({ ...s, messages: [...history, { role: 'assistant' as const, content: `错误: ${e.message}` }], ts: Date.now() }))
    } finally {
      setLoading(false)
    }
  }

  function addSession() {
    const s = newSession()
    setSessions(prev => { const next = [s, ...prev]; persist(next); return next })
    setActiveId(s.id)
    seedUsed.current = false
  }

  function copyMsg(content: string) {
    try { navigator.clipboard?.writeText(content) } catch { /* noop */ }
  }

  const stepIdx = currentStep ? (route?.steps.findIndex(s => s.id === currentStep.id) ?? -1) + 1 : 0

  return (
    <div className={`ai-chat ai-chat-${variant}`}>
      <div className="chat-head">
        <span className="av">AI</span>
        <h3>{variant === 'side' ? '代码助手' : (active?.title || 'AI 助手')}</h3>
        {variant === 'rail' && (
          <select
            className="sess-select mono"
            value={active?.id || ''}
            onChange={e => setActiveId(e.target.value)}
            title="切换会话（保存在本机浏览器）"
          >
            {sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        )}
        {variant === 'rail' && <button className="btn-mini" onClick={addSession} title="新会话">＋</button>}
        {currentStep && <span className="chip grn mono">步骤 {stepIdx}/{route?.steps.length || 0}</span>}
        {loading && <span className="chip"><span className="pulse" />回复中…</span>}
        {variant === 'side' && (
          <span className="side-actions">
            <button className="btn-mini" onClick={addSession} title="新会话">＋</button>
            <button className="btn-mini" onClick={onExpand} title="展开为完整 AI 界面">⤢</button>
            <button className="btn-mini" onClick={onClose} title="收起">×</button>
          </span>
        )}
      </div>

      <div className="msgs" ref={msgsRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-title">{identityMeta.icon} {identityMeta.name} · {identityMeta.hint}</div>
            <p>对文件、调用链或验证方法提问，助手会自动带入当前路线上下文。</p>
            {currentStep && <div className="chat-empty-context">{currentStep.title}{currentStep.file ? ` · ${currentStep.file}` : ''}</div>}
            <div className="chat-suggestions">
              {identityMeta.suggestions.map(question => (
                <button key={question} onClick={() => setInput(question)}>{question}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          m.role === 'user' ? (
            <div key={i} className="m-user">{m.content}</div>
          ) : (
            <div key={i} className="m-ai">
              <span className="av">AI</span>
              <div className="m-body">
                <Markdown>{m.content}</Markdown>
                <div className="m-act">
                  <span onClick={() => copyMsg(m.content)}>⧉ 复制</span>
                  <span onClick={() => setInput(prev => prev + (prev ? '\n' : '') + '关于刚才的回答：')}>↻ 追问</span>
                </div>
              </div>
            </div>
          )
        ))}
        {loading && (
          <div className="m-ai">
            <span className="av">AI</span>
            <div className="m-body"><span className="msg-loading"><span className="pulse" />思考中…</span></div>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="identity-row" role="tablist" aria-label="AI 身份切换">
          {AI_IDENTITIES.map(item => (
            <button
              key={item.id}
              role="tab"
              aria-selected={identity === item.id}
              className={`identity-chip ${identity === item.id ? 'on' : ''}`}
              title={item.hint}
              onClick={() => setIdentity(item.id)}
            >
              <span>{item.icon}</span>{item.name}
            </button>
          ))}
        </div>
        <div className="ctx-chips">
          {course && <span className="chip">📁 {course.slug}</span>}
          {currentStep && <span className="chip">📌 {currentStep.title}</span>}
          {currentStep?.file && <span className="chip mono">📄 {currentStep.file}</span>}
        </div>
        <textarea
          className="input-box"
          placeholder="提问：例如「这段为什么要 fail-fast？」 · Enter 发送 / Shift+Enter 换行"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        />
        <div className="composer-foot">
          <span className="grow" />
          <button className="send" onClick={send} disabled={loading || !input.trim()}>➤ 发送</button>
        </div>
      </div>
    </div>
  )
}
