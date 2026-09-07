import { useCallback, useContext, createContext, useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import Markdown from 'react-markdown'
import { api } from '../lib/api'
import { defineMonacoThemes, monacoThemeName } from '../lib/monacoThemes'
import { useTheme, cssVar } from '../theme/ThemeContext'
import type { Course, OpenRequest, Step, CheckResult, TestDef } from '../types'

interface EditorAreaProps {
  course: Course | undefined
  openReq: OpenRequest | null
  signal: { type: 'check' | 'preview'; ts: number } | null
  activeStep: Step | undefined
  routeId: string
  routeFiles: string[]
  onOpenFile: (path: string) => void
}

interface Tab { path: string; content: string; language: string; truncated: boolean; encoding: string }

const TAB_LIMIT = 8

/* ---------- 翻译挂点（B-04）：只提交非代码文本，结果不落任何存储 ---------- */
const translateCtx = { courseId: '' }   // EditorArea 挂载时写入，供 Monaco 命令闭包使用

const COMMENT_PREFIX: Record<string, string[]> = {
  python: ['#'], ini: ['#'], yaml: ['#'], shell: ['#'],
  go: ['//'], javascript: ['//'], typescript: ['//'], rust: ['//'], java: ['//'], c: ['//'], cpp: ['//']
}

/** 扫描连续注释行 → 可翻译块（去注释符，≤1200 字符；代码本体永不入选） */
function commentBlocks(model: any, prefixes: string[]) {
  const out: Array<{ start: number; end: number; text: string }> = []
  if (!prefixes.length) return out
  const lineCount = Math.min(model.getLineCount(), 4000)
  let start = 0
  let buf: string[] = []
  const flush = () => {
    if (buf.length) {
      const text = buf.join('\n')
      if (text.length >= 8 && text.length <= 1200) out.push({ start, end: start + buf.length - 1, text })
      buf = []
    }
  }
  for (let i = 1; i <= lineCount; i++) {
    const trimmed = String(model.getLineContent(i)).trimStart()
    // shebang / 编码声明是指令行，不是散文——不提供翻译入口
    const isDirective = /^#!\//.test(trimmed) || /^#\s*[-*]*\s*coding[:=]/i.test(trimmed)
    const isComment = !isDirective && trimmed.length > 4 && trimmed.length <= 200 && prefixes.some(p => trimmed.startsWith(p))
    if (isComment) {
      if (!buf.length) start = i
      buf.push(trimmed.replace(/^#+\s*/, '').replace(/^\/\/+\s*/, '').replace(/^\/\*+\s*/, '').replace(/[\s*]+\/$/, ''))
    } else flush()
  }
  flush()
  return out
}

/** 光标所在注释块（不在注释上返回 null） */
function commentBlockAt(model: any, line: number) {
  const prefixes = COMMENT_PREFIX[model.getLanguageId?.() || ''] || []
  return commentBlocks(model, prefixes).find(b => line >= b.start && line <= b.end) || null
}

/** 注释块译文以 viewZone 显示在块下方（E2E 复盘缺陷②：
 *  after 装饰的 inlineClassName 只作用于首个空白分段，样式与取值都不可靠；
 *  viewZone 整行 DOM 自持，loading/run/err 分 class，按块累积，切模型自动失效） */
const zoneMap = new WeakMap<any, Map<string, string>>()

function setBlockTranslation(editor: any, block: { start: number; end: number }, text: string, cls: string) {
  const model = editor.getModel()
  if (!model) return
  let zones = zoneMap.get(editor)
  if (!zones) { zones = new Map(); zoneMap.set(editor, zones) }
  const key = `${model.uri.toString()}:${block.start}:${block.end}`
  editor.changeViewZones((accessor: any) => {
    const old = zones!.get(key)
    if (old) { try { accessor.removeZone(old) } catch { /* noop */ } }
    const dom = document.createElement('div')
    dom.className = 'ct-trans-zone ' + cls
    dom.textContent = '⇲ ' + text
    dom.title = text
    const id = accessor.addZone({ afterLineNumber: block.end, heightInLines: 1, domNode: dom })
    zones!.set(key, id)
  })
}

/** 翻译注释块 → 块下方译文行；重复点击替换同块，多块累积共存 */
function runCommentTranslation(_monaco: any, editor: any, block: { start: number; end: number; text: string }, filePath: string) {
  setBlockTranslation(editor, block, '译文中…', 'ct-trans-loading')
  const lang = editor.getModel()?.getLanguageId?.() || 'code'
  api.aiTranslate({ courseId: translateCtx.courseId || undefined, text: block.text, context: `${lang} 源码注释（${filePath.split('/').pop()}）` })
    .then(r => {
      const flat = (r.content || r.error || '无响应').replace(/\s+/g, ' ').trim().slice(0, 300)
      setBlockTranslation(editor, block, flat, r.error ? 'ct-trans-err' : 'ct-trans-run')
    })
    .catch((e: any) => {
      setBlockTranslation(editor, block, `⚠ ${e.message}`, 'ct-trans-err')
    })
}

/** 浏览器翻译式整页翻译：一次请求批量译完文件内全部注释块，逐块渲染译文行。返回块数（0 = 无可译内容） */
function translateAllComments(editor: any, filePath: string): number {
  const model = editor.getModel()
  if (!model) return 0
  const lang = model.getLanguageId?.() || ''
  const prefixes = COMMENT_PREFIX[lang] || []
  const blocks = commentBlocks(model, prefixes)
  if (!blocks.length) return 0
  const context = `${lang || 'code'} 源码注释（${filePath.split('/').pop()}）`
  // 分片：单批 ≤120 块且 ≤9000 字符，多批并行发出
  const chunks: Array<typeof blocks> = []
  let cur: typeof blocks = []
  let size = 0
  for (const b of blocks) {
    if (cur.length && (cur.length >= 120 || size + b.text.length > 9000)) { chunks.push(cur); cur = []; size = 0 }
    cur.push(b); size += b.text.length
  }
  if (cur.length) chunks.push(cur)
  for (const chunk of chunks) {
    for (const b of chunk) setBlockTranslation(editor, b, '译文中…', 'ct-trans-loading')
    api.aiTranslateBatch({ courseId: translateCtx.courseId || undefined, blocks: chunk.map(b => b.text), context })
      .then(r => {
        const results = r.contents || []
        chunk.forEach((b, i) => {
          const flat = (results[i] || r.error || '无响应').replace(/\s+/g, ' ').trim().slice(0, 300)
          setBlockTranslation(editor, b, flat, results[i] && !r.error ? 'ct-trans-run' : 'ct-trans-err')
        })
      })
      .catch((e: any) => chunk.forEach(b => setBlockTranslation(editor, b, `⚠ ${e.message}`, 'ct-trans-err')))
  }
  return blocks.length
}

function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    py: 'python', go: 'go', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sql: 'sql', html: 'html', htm: 'html', css: 'css', sh: 'shell', bat: 'bat',
    md: 'markdown', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', h: 'c'
  }
  return map[ext] || 'plaintext'
}

interface TranslationChunk { readonly kind: 'text' | 'code'; readonly content: string }

function splitMarkdownForTranslation(content: string, maxChars = 18000): TranslationChunk[] {
  const lines = content.split(/(?<=\n)/)
  const chunks: TranslationChunk[] = []
  let prose = ''
  let code = ''
  let inFence = false
  const flushProse = () => {
    if (!prose) return
    chunks.push({ kind: 'text', content: prose })
    prose = ''
  }
  const flushCode = () => {
    if (!code) return
    chunks.push({ kind: 'code', content: code })
    code = ''
  }
  for (const line of lines) {
    const fence = /^\s*(```|~~~)/.test(line)
    if (fence && !inFence) {
      flushProse()
      inFence = true
      code += line
      continue
    }
    if (inFence) {
      code += line
      if (fence) {
        inFence = false
        flushCode()
      }
      continue
    }
    if (prose.length + line.length <= maxChars) {
      prose += line
    } else {
      flushProse()
      for (let offset = 0; offset < line.length; offset += maxChars) {
        const part = line.slice(offset, offset + maxChars)
        if (part.length === maxChars) chunks.push({ kind: 'text', content: part })
        else prose = part
      }
    }
  }
  if (inFence) flushCode()
  flushProse()
  return chunks
}

export function EditorArea({ course, openReq, signal, activeStep, routeId, routeFiles, onOpenFile }: EditorAreaProps) {
  const { theme } = useTheme()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [banner, setBanner] = useState<{ note: string; range?: [number, number] } | null>(null)
  const [mdMode, setMdMode] = useState<'render' | 'raw'>('render')
  const [bottomTab, setBottomTab] = useState<'check' | 'test' | 'preview' | null>(null)
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [testDef, setTestDef] = useState<TestDef>({ model: 'm1', cmdLang: 'python', expect: { exitOk: true, stdoutInclude: '' } })
  const [execLog, setExecLog] = useState<string>('')
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null)
  const [bookmarks, setBookmarks] = useState<number[]>([])
  const [showBookmarkList, setShowBookmarkList] = useState(false)
  const [batchResult, setBatchResult] = useState<Array<{ path: string; ok: boolean; issues: number }> | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [outline, setOutline] = useState<Array<{ name: string; kind: string; line: number; end: number; doc: string }> | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [outlineMeta, setOutlineMeta] = useState<{ role?: string; score?: number; importedBy?: number; readingMinutes?: number } | null>(null)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickQ, setQuickQ] = useState('')
  const [quickRes, setQuickRes] = useState<Array<{ path: string; name: string; type: 'file' | 'directory' }>>([])
  const quickTimer = useRef<number | null>(null)
  // md 段落翻译结果（短生命周期：切 tab / 换文件即清空）
  const [trans, setTrans] = useState<Record<string, { loading?: boolean; text?: string; error?: string }>>({})
  const [fullTranslation, setFullTranslation] = useState<{ text: string; error?: string } | null>(null)
  const [fullTranslationLoading, setFullTranslationLoading] = useState(false)
  // 光标所在注释块（非 null 时「译注释」按钮点亮）
  const [cursorBlock, setCursorBlock] = useState<{ start: number; end: number; text: string } | null>(null)

  useEffect(() => { setTrans({}); setFullTranslation(null); setFullTranslationLoading(false) }, [activePath])
  // 切 tab 时清掉上一文件的译文 viewZone（同 model setValue 不触发 onDidChangeModel）
  useEffect(() => {
    const ed = editorRef.current
    const zs = ed && zoneMap.get(ed)
    if (ed && zs && zs.size) {
      ed.changeViewZones((accessor: any) => { zs.forEach((id: string) => { try { accessor.removeZone(id) } catch { /* noop */ } }) ; zs.clear() })
    }
  }, [activePath])
  useEffect(() => { translateCtx.courseId = course?.id || '' }, [course?.id])
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const decorationsRef = useRef<any>(null)
  const bookmarkDecoRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const bmRef = useRef<{ path: string; lines: number[] }>({ path: '', lines: [] })

  const currentTab = tabs.find(t => t.path === activePath)
  const isMd = !!currentTab && /\.md$/i.test(currentTab.path)

  // ---- WS：测试执行日志流 ----
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws: WebSocket | null = null
    let closed = false
    const connect = () => {
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'exec') {
            setExecLog(prev => (prev + msg.chunk).slice(-80000))
          } else if (msg.type === 'done') {
            const v = msg.verdict || {}
            setVerdict({
              ok: !!v.ok,
              text: v.ok ? `✓ 通过（退出码 ${v.exitCode ?? 0}）` : `✗ 未通过：${v.error || v.reason || `退出码 ${v.exitCode}`}${v.diff ? '\n' + v.diff : ''}`
            })
          }
        } catch {}
      }
      ws.onclose = () => { if (!closed) setTimeout(connect, 3000) }
    }
    connect()
    wsRef.current = ws
    return () => { closed = true; ws?.close() }
  }, [])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [execLog])

  // ---- 打开文件（响应 openReq）----
  useEffect(() => {
    if (!openReq || !course) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.getFileContent(course.id, openReq.path)
        if (cancelled) return
        const tab: Tab = { path: openReq.path, content: res.content, language: detectLanguage(openReq.path), truncated: res.truncated, encoding: res.encoding }
        setTabs(prev => {
          const existing = prev.find(t => t.path === openReq.path)
          if (existing) return prev.map(t => t.path === openReq.path ? tab : t)
          if (prev.length >= TAB_LIMIT) prev = prev.slice(1) // FR-12：tab 上限 8
          return [...prev, tab]
        })
        setActivePath(openReq.path)
        setBanner(openReq.note ? { note: openReq.note, range: openReq.range } : openReq.range ? { note: '', range: openReq.range } : null)
        setMdMode('render')
        setVerdict(null)
        setBatchResult(null)
        // 载入该书签
        api.getBookmarks(course.id).then(map => {
          const lines = map[openReq.path] || []
          setBookmarks(lines)
          bmRef.current = { path: openReq.path, lines }
        }).catch(() => { setBookmarks([]); bmRef.current = { path: openReq.path, lines: [] } })
        // 载入已有测试定义
        api.getTestDef(course.id, openReq.path).then(def => {
          if (def && def.model) setTestDef(prev => ({ ...def, entry: def.entry || prev.entry }))
        }).catch(() => {})
        // 符号大纲（代码索引）
        setOutline(null)
        api.getSymbols(course.id, openReq.path).then(r => {
          setOutline(r.symbols || [])
          setOutlineMeta({ role: r.role, score: r.score, importedBy: r.importedBy, readingMinutes: r.readingMinutes })
        }).catch(() => { setOutline([]); setOutlineMeta(null) })
      } catch (e: any) {
        setBanner({ note: `⚠ 打开失败：${e.message}` })
      }
    })()
    return () => { cancelled = true }
  }, [openReq?.ts])

  // ---- range 高亮定位（FR-13）----
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current || !currentTab) return
    const editor = editorRef.current
    const monaco = monacoRef.current
    decorationsRef.current?.clear?.()
    if (banner?.range && banner.range[0] > 0) {
      const [start, end] = banner.range
      const range = new monaco.Range(start, 1, Math.max(end, start), 1)
      try {
        decorationsRef.current = editor.createDecorationsCollection([{
          range,
          options: { isWholeLine: true, className: 'step-highlight-line', overviewRuler: { color: cssVar('--accent') || '#888888', position: 4 } }
        }])
      } catch { decorationsRef.current = null }
      editor.revealRangeInCenter(range)
    }
  }, [activePath, currentTab?.content, banner?.range?.[0], banner?.range?.[1]])

  function jumpToLine(line: number) {
    if (!editorRef.current || !monacoRef.current) return
    const range = new monacoRef.current.Range(line, 1, line, 1)
    editorRef.current.revealRangeInCenter(range)
    editorRef.current.setPosition({ lineNumber: line, column: 1 })
    editorRef.current.focus?.()
  }

  // ---- FR-14 书签：点击行号槽切换，LDD 持久化 ----
  const applyBookmarkDecorations = useCallback(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    bookmarkDecoRef.current?.clear?.()
    if (bmRef.current.lines.length > 0) {
      bookmarkDecoRef.current = editor.createDecorationsCollection(
        bmRef.current.lines.map(line => ({
          range: new monaco.Range(line, 1, line, 1),
          options: { isWholeLine: true, className: 'bookmark-line', linesDecorationsClassName: 'bookmark-gutter' }
        }))
      )
    }
  }, [])

  // 书签 handler 在编辑器挂载时安装一次（onMount 后不再依赖后续渲染）
  async function toggleBookmark(line: number) {
    if (!course || !bmRef.current.path || line <= 0) return
    const cur = bmRef.current
    const next = cur.lines.includes(line) ? cur.lines.filter(l => l !== line) : [...cur.lines, line]
    try {
      const r = await api.setBookmarks(course.id, cur.path, next)
      bmRef.current = { path: cur.path, lines: r.lines }
      setBookmarks(r.lines)
    } catch {}
  }
  const handleGutterClickRef = useRef<(line: number) => void>(() => {})
  handleGutterClickRef.current = toggleBookmark

  useEffect(() => { applyBookmarkDecorations() }, [bookmarks, activePath])

  // ---- FR-15 P1：整条路线批量静态检查（仅代码文件；md/yaml 等跳过） ----
  async function runBatchCheck() {
    if (!course || routeFiles.length === 0) return
    const codeFiles = routeFiles.filter(f => /\.(py|go|js|jsx|ts|tsx|mjs|cjs)$/i.test(f))
    if (codeFiles.length === 0) {
      setBottomTab('check')
      setBatchResult([{ path: '路线内没有可静态检查的代码文件', ok: true, issues: 0 }])
      return
    }
    setBottomTab('check')
    setBatchRunning(true)
    setBatchResult(null)
    setCheckResult(null)
    try {
      setBatchResult(await api.staticCheckBatch(course.id, codeFiles))
    } catch (e: any) {
      setBatchResult([{ path: e.message, ok: false, issues: 1 }])
    } finally {
      setBatchRunning(false)
    }
  }

  // ---- 静态检查（FR-15）----
  const runCheck = useCallback(async () => {
    if (!course || !currentTab) { setCheckResult(null); return }
    setBottomTab('check')
    setChecking(true)
    setCheckResult(null)
    try {
      const r: CheckResult = await api.staticCheck(course.id, currentTab.path)
      setCheckResult(r)
    } catch (e: any) {
      setCheckResult({ kind: 'static', ok: false, items: [{ line: 0, msg: e.message, src: '' }], ms: 0 })
    } finally {
      setChecking(false)
    }
  }, [course?.id, currentTab?.path])

  // ---- 预览（FR-19）----
  const runPreview = useCallback(async () => {
    if (!course || !currentTab) return
    setBottomTab('preview')
    try {
      const r = await api.createPreview(course.id, currentTab.path)
      setPreviewUrl(r.url)
    } catch (e: any) {
      setPreviewUrl(null)
      setVerdict({ ok: false, text: `预览失败: ${e.message}` })
    }
  }, [course?.id, currentTab?.path])

  // ---- 顶栏信号 ----
  useEffect(() => {
    if (!signal) return
    if (signal.type === 'check') runCheck()
    if (signal.type === 'preview') runPreview()
  }, [signal?.ts])

  // ---- 测试（FR-16）----
  async function runTest() {
    if (!course || !currentTab) return
    setBottomTab('test')
    setExecLog('')
    setVerdict(null)
    try {
      await api.saveTestDef(course.id, currentTab.path, testDef)
      await api.runTest({ courseId: course.id, path: currentTab.path, testDef, routeId, stepId: activeStep?.id })
    } catch (e: any) {
      setVerdict({ ok: false, text: e.message })
    }
  }

  function closeTab(path: string) {
    setTabs(prev => {
      const next = prev.filter(t => t.path !== path)
      if (activePath === path) setActivePath(next[next.length - 1]?.path || null)
      return next
    })
  }

  /* ---------- md 段落「译」入口：pre/code 永不出现；纯中文段落不显示 ---------- */
  function textOf(children: any): string {
    if (children == null || typeof children === 'boolean') return ''
    if (typeof children === 'string' || typeof children === 'number') return String(children)
    if (Array.isArray(children)) return children.map(textOf).join(' ')
    if (typeof children === 'object' && 'props' in children) return textOf((children as any).props?.children)
    return ''
  }
  function isTranslatable(s: string): boolean {
    const t = s.trim()
    if (t.length < 24) return false
    const latin = (t.match(/[A-Za-z]/g) || []).length
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length
    return latin > cjk * 2 && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(t)
  }
  async function doTranslate(key: string, text: string) {
    setTrans(p => ({ ...p, [key]: { loading: true } }))
    try {
      const r = await api.aiTranslate({ courseId: translateCtx.courseId || undefined, text, context: 'Markdown 技术教程段落' })
      setTrans(p => ({ ...p, [key]: r.error ? { error: r.error } : { text: r.content || '' } }))
    } catch (e: any) {
      setTrans(p => ({ ...p, [key]: { error: e.message } }))
    }
  }

  async function translateDocument() {
    if (!currentTab || !isMd || fullTranslationLoading) return
    setFullTranslationLoading(true)
    setMdMode('render')
    try {
      const chunks = splitMarkdownForTranslation(currentTab.content)
      const translated: string[] = []
      for (const chunk of chunks) {
        if (chunk.kind === 'code') {
          translated.push(chunk.content)
          continue
        }
        const result = await api.aiTranslate({ courseId: translateCtx.courseId || undefined, text: chunk.content, context: `Markdown 技术教程（${currentTab.path.split('/').pop()}）` })
        if (result.error) throw new Error(result.error)
        translated.push(result.content || '')
      }
      const text = translated.join('')
      setFullTranslation(text ? { text } : { text: '', error: '空响应' })
    } catch (error) {
      setFullTranslation({ text: '', error: error instanceof Error ? error.message : String(error) })
    } finally {
      setFullTranslationLoading(false)
    }
  }

  function renderMarkdownMd(content: string) {
    let idx = 0
    // blockquote 是正文引用而非教程段落主体：不出「译」入口（验收驱动 Stage A 断言）
    const InQuote = createContext(false)
    const components = {
      blockquote: ({ children }: any) => (
        <InQuote.Provider value={true}><blockquote>{children}</blockquote></InQuote.Provider>
      ),
      p: ({ children }: any) => {
        const my = idx++
        const key = `${activePath}#${my}`
        const raw = textOf(children)
        const st = trans[key]
        const inQuote = useContext(InQuote)
        return (
          <div className="md-p">
            <p>
              {children}
              {!inQuote && isTranslatable(raw) && (
                <button className="tr-chip" disabled={st?.loading} title="翻译此段（仅非代码文本）" onClick={() => doTranslate(key, raw)}>
                  {st?.loading ? '…' : '译'}
                </button>
              )}
            </p>
            {st && (st.text || st.error) && (
              <div className="tr-card">
                <div className="tr-card-hd">
                  <b>译文</b>
                  <span className="tr-close" onClick={() => setTrans(p => { const n = { ...p }; delete n[key]; return n })}>×</span>
                </div>
                {st.error ? <span className="tr-err">⚠ {st.error}</span> : <Markdown>{st.text}</Markdown>}
              </div>
            )}
          </div>
        )
      }
    }
    return (
      <div className="md-render">
        <Markdown components={components}>{content}</Markdown>
      </div>
    )
  }

  if (!course) {
    return (
      <div className="editor-empty">
        <div className="editor-placeholder">
          <h3>CodeTrail 码途</h3>
          <p>从左侧文件树或学习面板选择内容开始阅读</p>
        </div>
      </div>
    )
  }

  return (
    <div className="editor-area">
      <div className="editor-header">
        <div className="editor-tabs" role="tablist">
          {tabs.map(tab => (
            <button
              key={tab.path}
              role="tab"
              aria-selected={activePath === tab.path}
              className={`tab ${activePath === tab.path ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.path)}
            >
              <span className="tab-name">{tab.path.split('/').pop()}</span>
              <span className="tab-close" onClick={e => { e.stopPropagation(); closeTab(tab.path) }}>×</span>
            </button>
          ))}
          {tabs.length >= TAB_LIMIT && <span className="tab-limit">{TAB_LIMIT} 个上限</span>}
        </div>
        {banner && (
          <div className="step-note-banner">
            <span className="note-label">{banner.range ? `步骤要点 (L${banner.range[0]}${banner.range[1] ? `-${banner.range[1]}` : ''})` : '提示'}</span>
            <span className="note-text">{banner.note}</span>
            <button className="banner-close" onClick={() => setBanner(null)}>×</button>
          </div>
        )}
      </div>

      <div className="editor-breadcrumb">
        <span className="crumb-course">{course.slug}</span>
        {(activePath || '').split('/').map((seg, i, arr) => (
          <span key={i} className={i === arr.length - 1 ? 'crumb-file' : 'crumb-seg'}>{seg}{i < arr.length - 1 ? ' ›' : ''}</span>
        ))}
        {currentTab?.truncated && <span className="file-truncated">（大文件已截断显示）</span>}
        {currentTab?.encoding === 'gbk' && <span className="file-truncated">（GBK 编码已转读）</span>}
        <button
          className={`bm-btn ${cursorBlock ? 'has' : ''}`}
          title={cursorBlock ? `只译第 ${cursorBlock.start}-${cursorBlock.end} 行注释（Ctrl+Alt+T）` : '一键翻译整个文件的注释块（浏览器翻译式，逐行渲染在注释下方）'}
          onClick={() => {
            const ed = editorRef.current
            const mo = monacoRef.current
            if (!ed || !mo || !currentTab) return
            if (cursorBlock) { runCommentTranslation(mo, ed, cursorBlock, currentTab.path); return }
            const n = translateAllComments(ed, currentTab.path)
            if (n === 0) setBanner({ note: '该文件没有可翻译的行注释（支持 # 与 // 注释；md 文件请用「译全文」）' })
          }}
        >
          🌐 译注释
        </button>
        <button
          className={`bm-btn ${quickOpen ? 'has' : ''}`}
          title="打开文件（全库搜索）"
          onClick={() => {
            setQuickOpen(v => {
              const nv = !v
              if (nv) { setQuickQ(''); setQuickRes([]) }   // 重开面板清空上次查询，避免残留拼接
              return nv
            })
            setOutlineOpen(false); setShowBookmarkList(false)
          }}
        >
          ⌕ 打开
        </button>
        <button
          className={`bm-btn ${outline && outline.length > 0 ? 'has' : ''}`}
          title="符号大纲（来自代码索引）"
          onClick={() => { setOutlineOpen(v => !v); setShowBookmarkList(false) }}
        >
          ☰ 大纲{outline && outline.length > 0 ? ` ${outline.length}` : ''}
        </button>
        <button
          className={`bm-btn ${bookmarks.length ? 'has' : ''}`}
          title="点击行号槽添加/移除书签（FR-14）"
          onClick={() => { setShowBookmarkList(v => !v); setOutlineOpen(false) }}
        >
          🔖 {bookmarks.length > 0 ? bookmarks.length : ''}
        </button>
        {quickOpen && (
          <div className="quick-panel">
            <input
              autoFocus
              placeholder="搜索文件（全库深搜）或从路线文件选择…"
              value={quickQ}
              onChange={e => {
                setQuickQ(e.target.value)
                if (quickTimer.current) window.clearTimeout(quickTimer.current)
                if (!course) return
                const q = e.target.value.trim()
                if (!q) { setQuickRes([]); return }
                quickTimer.current = window.setTimeout(async () => {
                  try { setQuickRes(await api.searchCourseFiles(course.id, q)) } catch { setQuickRes([]) }
                }, 300)
              }}
              onKeyDown={e => { if (e.key === 'Escape') setQuickOpen(false) }}
            />
            <div className="quick-list">
              {(quickQ.trim() ? quickRes.filter(r => r.type === 'file') : routeFiles.map(f => ({ path: f, name: f.split('/').pop() || f, type: 'file' as const }))).slice(0, 40).map(r => (
                <button key={r.path} className="quick-item" onClick={() => { onOpenFile(r.path); setQuickOpen(false) }}>
                  <span className="qn">{r.name}</span>
                  <span className="qp mono">{r.path}</span>
                </button>
              ))}
              {quickQ.trim() && quickRes.filter(r => r.type === 'file').length === 0 && <div className="panel-hint">无匹配文件</div>}
              {!quickQ.trim() && routeFiles.length === 0 && <div className="panel-hint">当前路线暂无关联文件，输入关键词搜索全库</div>}
            </div>
          </div>
        )}
        {outlineOpen && outline && outline.length > 0 && (
          <div className="outline-panel">
            <div className="outline-meta">
              {outlineMeta?.role === 'core' && <span className="role-badge role-core">核心</span>}
              {outlineMeta?.role === 'entry' && <span className="role-badge role-entry">入口</span>}
              {typeof outlineMeta?.score === 'number' && <span>重要度 {outlineMeta.score}</span>}
              {typeof outlineMeta?.importedBy === 'number' && <span>· 被 {outlineMeta.importedBy} 文件引用</span>}
              {outlineMeta?.readingMinutes && <span>· 约 {outlineMeta.readingMinutes} 分钟</span>}
            </div>
            <div className="outline-list">
              {outline.map((s, i) => (
                <button key={i} className="outline-item" onClick={() => { jumpToLine(s.line); setOutlineOpen(false) }} title={s.doc}>
                  <span className={`outline-kind k-${s.kind}`}>{s.kind === 'class' ? 'C' : 'ƒ'}</span>
                  <span className="outline-name">{s.name}</span>
                  <span className="outline-line">L{s.line}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {showBookmarkList && bookmarks.length > 0 && (
          <div className="bookmark-list">
            {bookmarks.map(l => (
              <button key={l} className="bookmark-item" onClick={() => { jumpToLine(l); setShowBookmarkList(false) }}>
                L{l}
              </button>
            ))}
          </div>
        )}
        {isMd && (
          <span className="md-toggle">
            <button className={fullTranslation ? 'active' : ''} onClick={translateDocument} disabled={fullTranslationLoading} title="只在界面中显示临时译文，不修改文件">
              {fullTranslationLoading ? '翻译中…' : '译全文'}
            </button>
            <button className={mdMode === 'render' ? 'active' : ''} onClick={() => setMdMode('render')}>渲染</button>
            <button className={mdMode === 'raw' ? 'active' : ''} onClick={() => setMdMode('raw')}>源码</button>
          </span>
        )}
      </div>

      <div className="editor-container">
        {!currentTab ? (
          <div className="editor-placeholder">
            <h3>{course.slug}</h3>
            <p>选择左侧文件或路线步骤开始阅读</p>
          </div>
        ) : isMd && mdMode === 'render' ? (
          fullTranslation?.error
            ? <div className="md-translation-error">译文生成失败：{fullTranslation.error}</div>
            : fullTranslation?.text
              ? <div className="md-translation-view"><div className="md-translation-label">界面译文 · 未修改源文件</div>{renderMarkdownMd(fullTranslation.text)}</div>
              : renderMarkdownMd(currentTab.content)
        ) : (
          <Editor
            height="100%"
            language={currentTab.language}
            value={currentTab.content}
            theme={monacoThemeName(theme)}
            beforeMount={monaco => { defineMonacoThemes(monaco) }}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              monacoRef.current = monaco
              defineMonacoThemes(monaco)
              monaco.editor.setTheme(monacoThemeName(theme))
              // B-04：光标进入注释块时点亮「译注释」按钮；Ctrl+Alt+T 快捷键；切文件清掉旧译文装饰
              const syncCursor = () => {
                const m = editor.getModel()
                const pos = editor.getPosition()
                setCursorBlock(m && pos ? commentBlockAt(m, pos.lineNumber) : null)
              }
              editor.onDidChangeCursorPosition(syncCursor)
              editor.onDidChangeModel(() => { zoneMap.get(editor)?.clear(); setCursorBlock(null) })
              editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyT, () => {
                const m = editor.getModel()
                const pos = editor.getPosition()
                if (!m || !pos) return
                const b = commentBlockAt(m, pos.lineNumber)
                const path = String(m.uri.path || '')
                if (b) runCommentTranslation(monaco, editor, b, path)
                else translateAllComments(editor, path)
              })
              syncCursor()
              // FR-14：点击行号槽/装订线切换书签（MouseTargetType: 2=GUTTER_GUTTER 3=GUTTER_LINE_LINE_NUMBERS 4=GUTTER_LINE_DECORATIONS）
              editor.onMouseDown((e: any) => {
                const t = e.target
                const isGutter = t.type === 2 || t.type === 3 || t.type === 4
                if (isGutter && t.position?.lineNumber) {
                  handleGutterClickRef.current(t.position.lineNumber)
                }
              })
            }}
            options={{
              minimap: { enabled: false },
              readOnly: true,
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'off',
              automaticLayout: true
            }}
          />
        )}
      </div>

      <div className="bottom-panel">
        <div className="bottom-tabs">
          <button className={bottomTab === 'check' ? 'active' : ''} onClick={() => { setBottomTab('check'); if (currentTab) runCheck() }}>🔍 静态检查</button>
          <button className={bottomTab === 'test' ? 'active' : ''} onClick={() => setBottomTab('test')}>🧪 测试闯关</button>
          <button className={bottomTab === 'preview' ? 'active' : ''} onClick={() => { setBottomTab('preview'); if (currentTab) runPreview() }}>👁 预览</button>
          <span className="bottom-spacer" />
          {currentTab && <span className="current-file-hint">{currentTab.path}</span>}
        </div>

        {bottomTab === 'check' && (
          <div className="bottom-content">
            <div className="check-toolbar">
              <button className="btn-mini" onClick={() => currentTab && runCheck()} disabled={checking || !currentTab}>检查当前文件</button>
              {routeFiles.length > 0 && (
                <button className="btn-mini" onClick={runBatchCheck} disabled={batchRunning}>
                  {batchRunning ? '批量检查中…' : `📋 检查整条路线（${routeFiles.length} 文件）`}
                </button>
              )}
            </div>
            {batchResult && (
              <ul className="check-items">
                {batchResult.map((r, i) => (
                  <li key={i} className="check-item" onClick={() => onOpenFile(r.path)}>
                    <span className={`batch-status ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? '✓' : `✗ ${r.issues}`}</span>
                    <span className="check-msg">{r.path}</span>
                  </li>
                ))}
              </ul>
            )}
            {!batchResult && !checking && !checkResult && <div className="panel-hint">「检查当前文件」执行 py_compile / node --check / go vet；「检查整条路线」批量检查路线内全部文件。</div>}
            {!batchResult && checking && <div className="panel-hint">检查中…</div>}
            {!batchResult && !checking && checkResult && (
              <>
                <div className={`verdict ${checkResult.ok ? 'ok' : 'bad'}`}>
                  {checkResult.ok ? `✓ 通过（${checkResult.ms}ms）` : `✗ ${checkResult.items.length} 个问题（${checkResult.ms}ms）`}
                  {checkResult.unavailable && <span className="install-hint">{checkResult.items[0]?.msg}</span>}
                </div>
                <ul className="check-items">
                  {checkResult.items.map((it, i) => (
                    <li key={i} className="check-item" onClick={() => it.line > 0 && jumpToLine(it.line)}>
                      {it.line > 0 && <span className="check-line">L{it.line}</span>}
                      <span className="check-msg">{it.msg}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {bottomTab === 'test' && currentTab && (
          <div className="bottom-content test-panel">
            <div className="test-config">
              <label>
                模型
                <select value={testDef.model} onChange={e => setTestDef({ ...testDef, model: e.target.value as 'm1' | 'm2' })}>
                  <option value="m1">M1 输出比对</option>
                  <option value="m2">M2 断言脚本</option>
                </select>
              </label>
              <label>
                语言
                <select value={testDef.cmdLang || 'python'} onChange={e => setTestDef({ ...testDef, cmdLang: e.target.value })}>
                  <option value="python">python (uv)</option>
                  <option value="javascript">node</option>
                  <option value="go">go</option>
                </select>
              </label>
              {testDef.model === 'm1' ? (
                <>
                  <label className="grow">
                    期望输出包含
                    <input
                      value={testDef.expect?.stdoutInclude || ''}
                      onChange={e => setTestDef({ ...testDef, expect: { ...testDef.expect, stdoutInclude: e.target.value, exitOk: true } })}
                      placeholder="如 Hello CodeTrail"
                    />
                  </label>
                  <label className="grow">
                    stdin（可选）
                    <input value={testDef.stdin || ''} onChange={e => setTestDef({ ...testDef, stdin: e.target.value })} />
                  </label>
                </>
              ) : (
                <label className="grow">
                  断言脚本路径（相对课程根）
                  <input
                    value={testDef.entry || ''}
                    onChange={e => setTestDef({ ...testDef, entry: e.target.value })}
                    placeholder="如 tests/test_xxx.py"
                  />
                </label>
              )}
              <button className="btn-run-test" onClick={runTest}>▶ 运行测试</button>
            </div>
            {activeStep && (
              <div className="panel-hint">test 步骤通过后将自动标记完成（步骤：{activeStep.title}）</div>
            )}
            <pre className="exec-log" ref={logRef}>{execLog || '运行输出将在这里流式显示…'}</pre>
            {verdict && <div className={`verdict ${verdict.ok ? 'ok' : 'bad'}`} style={{ whiteSpace: 'pre-wrap' }}>{verdict.text}</div>}
          </div>
        )}

        {bottomTab === 'preview' && (
          <div className="bottom-content preview-panel">
            {previewUrl ? (
              <iframe src={previewUrl} title="preview" className="preview-frame" sandbox="allow-same-origin" />
            ) : (
              <div className="panel-hint">点击「预览」渲染当前 md / html 文件（5 分钟无访问自动关闭）</div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  function setActiveTab(path: string) {
    setActivePath(path)
    setVerdict(null)
  }
}
