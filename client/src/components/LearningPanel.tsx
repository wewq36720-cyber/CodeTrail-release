import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Course, Route, Step, StepProgress } from '../types'

interface LearningPanelProps {
  course: Course | undefined
  route: Route | undefined
  progress: Record<string, StepProgress>
  onProgressChange: (stepId: string, patch: Partial<StepProgress>) => void
  onStepActivate: (step: Step) => void
}

const STEP_TYPE_LABEL: Record<Step['type'], string> = {
  file: '文件', doc: '文档', test: '测试', checkpoint: '检查点'
}

/* 学习面板（main 稿右栏）：路线进度 + 步骤卡 + detail 卡 + AI 入口条 */
export function LearningPanel({ course, route, progress, onProgressChange, onStepActivate }: LearningPanelProps) {
  const [activeStepId, setActiveStepId] = useState<string | null>(null)
  const [ratingFor, setRatingFor] = useState<string | null>(null)   // 完成时弹自评
  const [note, setNote] = useState('')
  const [noteLoadedFor, setNoteLoadedFor] = useState<string>('')
  const [noteSavedAt, setNoteSavedAt] = useState<number | null>(null)

  const currentStep = (route?.steps || []).find(s => s.id === activeStepId) || null
  const currentProgress = activeStepId ? progress[activeStepId] : null
  const doneCount = (route?.steps || []).filter(s => ['done', 'skipped'].includes(progress[s.id]?.status || '')).length

  useEffect(() => {
    setActiveStepId(null)
    setRatingFor(null)
  }, [route?.id])

  // 笔记加载/切换
  useEffect(() => {
    if (!course || !currentStep) return
    const key = `${course.id}__${currentStep.id}`
    if (noteLoadedFor === key) return
    api.getNotes(course.id, currentStep.id).then(list => {
      setNote(list[0]?.__content ?? '')
      setNoteLoadedFor(key)
      setNoteSavedAt(null)
    }).catch(() => { setNote(''); setNoteLoadedFor(key) })
  }, [course?.id, currentStep?.id])

  function handleStepClick(step: Step) {
    setActiveStepId(step.id)
    setRatingFor(null)
    if (progress[step.id]?.status === 'todo' || !progress[step.id]) {
      onProgressChange(step.id, { status: 'doing' }) // FR-20：打开过 = 进行中
    }
    onStepActivate(step) // 联动编辑器（FR-13）
  }

  function requestComplete(step: Step) {
    if (step.type === 'checkpoint') {
      onProgressChange(step.id, { status: 'done' })
      return
    }
    setRatingFor(step.id) // 弹自评 1~5（FR-21）
  }

  function confirmComplete(rating: number) {
    if (!activeStepId || !ratingFor) return
    onProgressChange(activeStepId, { status: 'done', self_rating: rating })
    setRatingFor(null)
  }

  async function saveNote() {
    if (!course || !currentStep) return
    try {
      await api.saveNote({ courseId: course.id, stepId: currentStep.id, title: `笔记 · ${currentStep.title}`, content: note })
      setNoteSavedAt(Date.now())
    } catch (e: any) {
      alert(`笔记保存失败: ${e.message}`)
    }
  }

  function statusIcon(status?: string): { glyph: string; cls: string } {
    switch (status) {
      case 'done': return { glyph: '✓', cls: 'status-done' }
      case 'doing': return { glyph: '▸', cls: 'status-doing' }
      case 'skipped': return { glyph: '⊘', cls: 'status-skipped' }
      default: return { glyph: '○', cls: 'status-todo' }
    }
  }

  if (!route) {
    return (
      <div className="learning-panel-empty">
        <p>当前课程还没有路线</p>
        <p className="hint">点击顶栏「路线」创建「自动梳理路线」或导入 md 指南</p>
      </div>
    )
  }

  const percent = route.steps.length ? Math.round(doneCount / route.steps.length * 100) : 0

  return (
    <div className="learning-panel">
      <div className="learn-head">
        <span className="pane-title">学习面板</span>
        <div className="route-chip" title="路线管理见顶栏「路线」">★ {route.name}</div>
      </div>

      <div className="route-progress-mini">
        <div className="progress-bar"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
        <span className="route-progress-text">{doneCount}/{route.steps.length}</span>
      </div>

      <div className="steps-list">
        {route.steps.map(step => {
          const p = progress[step.id]
          const si = statusIcon(p?.status)
          return (
            <button
              key={step.id}
              className={`step-item ${activeStepId === step.id ? 'active' : ''} ${si.cls}`}
              onClick={() => handleStepClick(step)}
            >
              <span className="step-icon">{si.glyph}</span>
              <span className="step-title">{step.title}</span>
              <span className={`step-type-badge type-${step.type}`}>{STEP_TYPE_LABEL[step.type]}</span>
            </button>
          )
        })}
      </div>

      {currentStep && (
        <div className="step-detail">
          <div className="step-header">
            <h4>{currentStep.title}</h4>
            <span className={`step-type-badge type-${currentStep.type}`}>{STEP_TYPE_LABEL[currentStep.type]}</span>
          </div>

          {currentStep.file && (
            <div className="step-file-info">
              <span>📄 {currentStep.file}</span>
              {currentStep.range && <span>L{currentStep.range[0]}-{currentStep.range[1]}</span>}
            </div>
          )}

          {currentStep.note && (
            <div className="step-note">{currentStep.note.slice(0, 600)}</div>
          )}

          <div className="step-actions">
            {currentStep.type === 'test' ? (
              <div className="hint-line">在编辑器下方「🧪 测试闯关」配置并运行测试，通过后自动标记完成</div>
            ) : (
              <button
                className="btn-primary"
                onClick={() => requestComplete(currentStep)}
                disabled={currentProgress?.status === 'done'}
              >
                {currentProgress?.status === 'done' ? '已完成 ✓' : '✓ 标记完成'}
              </button>
            )}
            <button className="btn-secondary" onClick={() => onProgressChange(currentStep.id, { status: 'skipped' })}>
              跳过
            </button>
            {currentProgress?.status === 'done' && (
              <button className="btn-secondary" onClick={() => onProgressChange(currentStep.id, { status: 'doing' })}>
                回改
              </button>
            )}
          </div>

          {ratingFor === currentStep.id && (
            <div className="rating-modal">
              <div className="rating-title">这段内容你理解到什么程度？</div>
              <div className="rating-options">
                {[1, 2, 3, 4, 5].map(r => (
                  <button key={r} className="rating-btn" onClick={() => confirmComplete(r)} title={['完全不懂', '大致了解', '基本掌握', '熟练运用', '精通可教'][r - 1]}>
                    {r}
                  </button>
                ))}
              </div>
              <div className="rating-hint">1 完全不懂 · 3 基本掌握 · 5 精通可教（≤3 自动进入复习队列）</div>
            </div>
          )}

          <div className="notes-section">
            <div className="notes-header">
              <span>📝 笔记（Markdown，可写行号引用）</span>
              {noteSavedAt && <span className="note-saved">已保存 ✓</span>}
            </div>
            <textarea
              placeholder="记录理解、疑问、行号引用（如 L48-180 的主循环）..."
              value={note}
              onChange={e => setNote(e.target.value)}
              className="notes-input"
              rows={4}
            />
            <button className="btn-save-note" onClick={saveNote}>保存笔记</button>
          </div>
        </div>
      )}
    </div>
  )
}
