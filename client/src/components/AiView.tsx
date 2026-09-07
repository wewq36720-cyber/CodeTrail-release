import { useEffect, useState } from 'react'
import { AiChat } from './AiChat'
import { EditorArea } from './EditorArea'
import { FileTree } from './FileTree'
import { api } from '../lib/api'
import type { Course, Route, Step, StepProgress, OpenRequest } from '../types'

interface AiViewProps {
  course: Course | undefined
  route: Route | undefined
  progress: Record<string, StepProgress>
  openReq: OpenRequest | null
  signal: { type: 'check' | 'preview'; ts: number } | null
  routeFiles: string[]
  onOpenFile: (path: string, opts?: { range?: [number, number]; note?: string; stepId?: string }) => void
  onProgressChange: (stepId: string, patch: Partial<StepProgress>) => void
}

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null || raw.trim() === '') return fallback
    const value = Number(raw)
    if (Number.isFinite(value)) return Math.max(min, Math.min(max, value))
  } catch (error) {
    if (error instanceof DOMException) return fallback
    throw error
  }
  return fallback
}

const TYPE_LABEL: Record<Step['type'], string> = { file: '文件', doc: '文档', test: '测试', checkpoint: '检查点' }

/* AI 助手界面（VSCode 式布局）：文件树常驻左栏 · 编辑器居中（当前步骤卡置顶）· 对话区在右，两条可拖拽分隔条 */
export function AiView({ course, route, progress, openReq, signal, routeFiles, onOpenFile, onProgressChange }: AiViewProps) {
  const steps = route?.steps || []
  const current = steps.find(s => s.id === openReq?.stepId)
    || steps.find(s => progress[s.id]?.status === 'doing')
    || steps.find(s => !progress[s.id] || progress[s.id].status === 'todo')
    || steps[0]
  const st = current ? progress[current.id]?.status : undefined
  const [ratingFor, setRatingFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [noteLoadedFor, setNoteLoadedFor] = useState('')
  const [noteSavedAt, setNoteSavedAt] = useState<number | null>(null)
  const [treeOpen, setTreeOpen] = useState(() => {
    try { return localStorage.getItem('ct-tree-open') !== '0' } catch (error) {
      if (error instanceof DOMException) return true
      throw error
    }
  })
  const [notesOpen, setNotesOpen] = useState(() => {
    try { return localStorage.getItem('ct-notes-open') !== '0' } catch (error) {
      if (error instanceof DOMException) return true
      throw error
    }
  })
  const [treeWidth, setTreeWidth] = useState(() => readWidth('ct-tree-width', 286, 220, 480))
  const [chatWidth, setChatWidth] = useState(() => readWidth('ct-chat-width', 420, 320, 720))
  useEffect(() => {
    try { localStorage.setItem('ct-tree-open', treeOpen ? '1' : '0') } catch (error) {
      if (!(error instanceof DOMException)) throw error
    }
  }, [treeOpen])
  useEffect(() => {
    try {
      localStorage.setItem('ct-notes-open', notesOpen ? '1' : '0')
      localStorage.setItem('ct-tree-width', String(treeWidth))
      localStorage.setItem('ct-chat-width', String(chatWidth))
    } catch (error) {
      if (!(error instanceof DOMException)) throw error
    }
  }, [notesOpen, treeWidth, chatWidth])

  function startResize(kind: 'tree' | 'chat', event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const initial = kind === 'tree' ? treeWidth : chatWidth
    const min = kind === 'tree' ? 220 : 320
    const max = kind === 'tree' ? 480 : 720
    const dir = kind === 'tree' ? 1 : -1   // 左栏随指针右移变宽；右栏镜像方向
    const onMove = (move: PointerEvent) => {
      const next = Math.max(min, Math.min(max, initial + dir * (move.clientX - startX)))
      if (kind === 'tree') setTreeWidth(next)
      else setChatWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('ct-resizing')
    }
    document.body.classList.add('ct-resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  useEffect(() => {
    if (!course || !current) return
    const key = `${course.id}__${current.id}`
    if (noteLoadedFor === key) return
    api.getNotes(course.id, current.id).then(list => {
      setNote(list[0]?.__content ?? '')
      setNoteLoadedFor(key)
      setNoteSavedAt(null)
    }).catch(() => { setNote(''); setNoteLoadedFor(key) })
  }, [course?.id, current?.id])

  async function saveNote() {
    if (!course || !current) return
    try {
      await api.saveNote({ courseId: course.id, stepId: current.id, title: `笔记 · ${current.title}`, content: note })
      setNoteSavedAt(Date.now())
    } catch (error) {
      alert(`笔记保存失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function complete(step: Step) {
    if (step.type === 'checkpoint') { onProgressChange(step.id, { status: 'done' }); return }
    setRatingFor(step.id)
  }

  const idx = current ? steps.findIndex(s => s.id === current.id) + 1 : 0
  const gridCols = treeOpen
    ? `${treeWidth}px 12px minmax(0, 1fr) 12px ${chatWidth}px`
    : `34px minmax(0, 1fr) 12px ${chatWidth}px`

  return (
    <div className="ai-work" style={{ gridTemplateColumns: gridCols }}>
      {treeOpen ? (
        <div className="pane ai-tree">
          <div className="tree-close-row">
            <span className="hint">文件树</span>
            <button className="btn-mini" onClick={() => setTreeOpen(false)} title="收起文件树">收起</button>
          </div>
          <div className="ai-tree-files">
            <FileTree course={course} route={route} progress={progress} onFileClick={path => onOpenFile(path)} />
          </div>
          {current && (
            <div className="pane step-card step-card-side">
              <div className="sc-head">
                <span className="sc-idx mono">{String(idx).padStart(2, '0')}/{steps.length}</span>
                <span className={`step-type-badge type-${current.type}`}>{TYPE_LABEL[current.type]}</span>
                <span className="sc-title">{current.title}</span>
              </div>
              {current.file && (
                <button className="sc-file mono" onClick={() => onOpenFile(current.file!, { range: current.range, note: current.note, stepId: current.id })} title="在编辑器打开">
                  📄 {current.file}{current.range ? ` · L${current.range[0]}-${current.range[1]}` : ''} ↗
                </button>
              )}
              {current.stage && <div className="sc-stage">{current.stage}{current.slot ? ` · ${current.slot}` : ''}</div>}
              {current.note && <div className="sc-note" title={current.note}>{current.note.slice(0, 300)}</div>}
              <div className="sc-actions">
                {st === 'done'
                  ? <button className="btn-secondary" onClick={() => onProgressChange(current.id, { status: 'doing' })}>回改</button>
                  : current.type === 'test'
                    ? <span className="hint-line">运行编辑器「测试闯关」，通过自动完成</span>
                    : <button className="btn-primary" onClick={() => complete(current)}>✓ 标记完成</button>}
                {st !== 'done' && st !== 'skipped' && (
                  <button className="btn-secondary" onClick={() => onProgressChange(current.id, { status: 'skipped' })}>跳过</button>
                )}
                {st === 'done' && <span className="sc-done">已完成 ✓</span>}
              </div>
              {ratingFor === current.id && (
                <div className="rating-options" style={{ marginTop: 6 }}>
                  {[1, 2, 3, 4, 5].map(r => (
                    <button key={r} className="rating-btn" title={['完全不懂', '大致了解', '基本掌握', '熟练运用', '精通可教'][r - 1]}
                      onClick={() => { onProgressChange(current.id, { status: 'done', self_rating: r }); setRatingFor(null) }}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <section className={`ai-notes ${notesOpen ? '' : 'collapsed'}`}>
            <div className="ai-notes-head">
              <span>学习笔记</span>
              <button className="btn-mini" onClick={() => setNotesOpen(value => !value)} title={notesOpen ? '收起学习笔记' : '展开学习笔记'}>{notesOpen ? '收起' : '展开'}</button>
            </div>
            {notesOpen && <div className="ai-notes-body">
              <textarea className="notes-input" rows={4} placeholder="笔记（支持行号引用）…" value={note} onChange={e => setNote(e.target.value)} />
              <button className="btn-save-note" onClick={saveNote}>{noteSavedAt ? '已保存 ✓' : '保存笔记'}</button>
            </div>}
          </section>
        </div>
      ) : (
        <button className="tree-tab" onClick={() => setTreeOpen(true)} title="展开文件树" aria-label="展开文件树">
          <span aria-hidden="true">≡</span><span className="tree-tab-label">文件树</span>
        </button>
      )}

      {treeOpen && <div className="ai-splitter" role="separator" aria-label="调整文件树宽度" onPointerDown={event => startResize('tree', event)} />}

      <div className="pane ai-work-editor">
        <EditorArea
          course={course}
          openReq={openReq}
          signal={signal}
          activeStep={current}
          routeId={route?.id || ''}
          routeFiles={routeFiles}
          onOpenFile={path => onOpenFile(path)}
        />
      </div>

      <div className="ai-splitter" role="separator" aria-label="调整对话区宽度" onPointerDown={event => startResize('chat', event)} />

      <div className="pane ai-work-chat">
        <AiChat variant="rail" course={course} route={route} progress={progress} />
      </div>
    </div>
  )
}
