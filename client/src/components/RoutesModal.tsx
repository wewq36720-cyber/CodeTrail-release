import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Course, Route, RouteTemplate, RouteTemplateId, Step } from '../types'

interface RoutesModalProps {
  course: Course
  routes: Route[]
  activeRouteId: string
  onClose: () => void
  onRoutesChanged: (activateRouteId?: string) => Promise<void>
  onOpenFile: (path: string) => void
  notify: (text: string, kind?: 'ok' | 'err') => void
}

function routeDescriptor(route: Route, templates: RouteTemplate[]): string {
  const template = templates.find(item => item.id === route.templateId)
  if (template) return template.name
  return route.steps.find(step => step.stage)?.stage
    || route.steps.find(step => step.title)?.title.replace(/^.+?：/, '').slice(0, 18)
    || '未分类路线'
}

function routeDisplayName(route: Route, templates: RouteTemplate[]): string {
  if (route.name && !route.name.includes('\uFFFD')) return route.name
  return templates.find(item => item.id === route.templateId)?.name || '未命名路线'
}

// FR-07~11：路线 CRUD / 编辑器 / 三来源（智能路线=代码索引、md 导入、AI 草案）
export function RoutesModal({ course, routes, activeRouteId, onClose, onRoutesChanged, onOpenFile, notify }: RoutesModalProps) {
  const [tab, setTab] = useState<'list' | 'import' | 'ai'>('list')
  const [editRoute, setEditRoute] = useState<Route | null>(null)
  const [newName, setNewName] = useState('')
  const [importPath, setImportPath] = useState('')
  const [importSection, setImportSection] = useState('Phase 2')
  const [importTarget, setImportTarget] = useState(course.id)
  const [importName, setImportName] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiDraft, setAiDraft] = useState<Step[] | null>(null)
  const [aiWarnings, setAiWarnings] = useState<string[]>([])
  const [templateId, setTemplateId] = useState<RouteTemplateId>('codebase-onboarding')
  const [templates, setTemplates] = useState<RouteTemplate[]>([])
  const [busy, setBusy] = useState(false)
  const [indexSummary, setIndexSummary] = useState<any>(null)
  const [indexBuilding, setIndexBuilding] = useState(false)

  // 架构概览：来自代码索引（入口 + 核心文件 + 重要度）
  const loadIndex = () => {
    api.getIndexSummary(course.id).then(s => setIndexSummary(s?.missing ? null : s)).catch(() => setIndexSummary(null))
  }
  useEffect(() => { loadIndex() }, [course.id])
  useEffect(() => {
    api.getRouteTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])

  const selectedTemplate = templates.find(template => template.id === templateId)
  const routeLabels = new Map(routes.map(route => [route.id, `${routeDisplayName(route, templates)} · ${routeDescriptor(route, templates)}`]))

  async function refreshIndex() {
    setIndexBuilding(true)
    try {
      await api.refreshIndex(course.id)
      loadIndex()
      notify('索引已重建')
    } catch (e: any) {
      notify(`索引构建失败: ${e.message}`, 'err')
    } finally {
      setIndexBuilding(false)
    }
  }

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true)
    try { await fn() } catch (e: any) { notify(e.message, 'err') } finally { setBusy(false) }
  }

  async function createBlank() {
    await withBusy(async () => {
      const r = await api.createRoute(course.id, { name: newName || '新路线', templateId, steps: [{ id: 's1', type: 'checkpoint', title: '第一个步骤' }] })
      setNewName('')
      await onRoutesChanged(r.id)
      notify('路线已创建')
    })
  }

  async function createAutoDraft() {
    await withBusy(async () => {
      const r = await api.autoDraftRoute(course.id, templateId, newName || undefined)
      await onRoutesChanged(r.id)
      notify(`已生成「${r.name}」，${r.steps.length} 个步骤`)
    })
  }

  async function doImport() {
    await withBusy(async () => {
      const r = await api.importMdRoute({
        courseId: importTarget,
        mdPath: importPath,
        section: importSection || undefined,
        routeName: importName || undefined,
        templateId
      })
      const warn = r.warnings?.length ? `（${r.warnings.length} 条告警：${r.warnings[0]}${r.warnings.length > 1 ? ' 等' : ''}）` : ''
      await onRoutesChanged(r.id)
      notify(`导入成功：${r.steps.length} 步${warn}`)
    })
  }

  async function genAi() {
    await withBusy(async () => {
      const r = await api.genAiRoute(course.id, aiPrompt || undefined, templateId)
      if (r.error) { notify(r.error, 'err'); return }
      setAiDraft(r.steps as Step[])
      setAiWarnings(r.warnings || [])
      const warn = r.warnings?.length ? `（${r.warnings.length} 条修正/告警）` : ''
      notify(`AI 草案 ${r.steps.length} 步，请确认后保存${warn}`)
    })
  }

  async function saveAiDraft() {
    if (!aiDraft?.length) return
    await withBusy(async () => {
      const tpl = templates.find(t => t.id === templateId)
      const auto = aiPrompt ? `AI · ${aiPrompt.slice(0, 16)}` : `AI · ${tpl?.name || '路线'}`
      const r = await api.createRoute(course.id, { name: auto, steps: aiDraft, templateId })
      setAiDraft(null)
      setAiWarnings([])
      await onRoutesChanged(r.id)
      notify('AI 路线已保存')
    })
  }

  function editExisting(r: Route) {
    setTab('list')
    setEditRoute(JSON.parse(JSON.stringify(r)))
  }

  async function saveEdits() {
    if (!editRoute) return
    await withBusy(async () => {
      await api.updateRoute(course.id, editRoute.id, { name: editRoute.name, steps: editRoute.steps, templateId: editRoute.templateId })
      await onRoutesChanged(editRoute.id)
      setEditRoute(null)
      notify('路线已保存')
    })
  }

  function mutateSteps(fn: (steps: Step[]) => void) {
    if (!editRoute) return
    const steps = JSON.parse(JSON.stringify(editRoute.steps))
    fn(steps)
    setEditRoute({ ...editRoute, steps })
  }

  function moveStep(i: number, dir: -1 | 1) {
    mutateSteps(steps => {
      const j = i + dir
      if (j < 0 || j >= steps.length) return
      ;[steps[i], steps[j]] = [steps[j], steps[i]]
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>🗺 路线管理 · {course.slug}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-tabs">
          <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>路线列表</button>
          <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>导入 md 指南</button>
          <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI 草案</button>
        </div>

        <div className="modal-content">
          {tab === 'list' && !editRoute && (
            <div className="settings-section">
              {/* 架构概览（代码索引） */}
              <div className="arch-overview">
                <div className="arch-header">
                  <span>🏛 架构概览（代码索引）</span>
                  {indexSummary && (
                    <button className="btn-mini" onClick={refreshIndex} disabled={indexBuilding}>
                      {indexBuilding ? '分析中…' : indexSummary.stale ? '⚠ 索引已过期，点击重建' : '重建索引'}
                    </button>
                  )}
                </div>
                {!indexSummary && !indexBuilding && (
                  <div className="arch-empty">
                    <button className="btn-mini" onClick={refreshIndex} disabled={indexBuilding}>
                      {indexBuilding ? '分析中…' : '构建代码索引（符号提取 + 依赖分析 + 重要性排序）'}
                    </button>
                  </div>
                )}
                {indexSummary && (
                  <div className="arch-body">
                    <div className="arch-col">
                      <div className="arch-col-title">入口（启动流程从这里读）</div>
                      {(indexSummary.entries || []).map((f: any) => (
                        <div key={f.path} className="arch-file" onClick={() => { onOpenFile(f.path) }} title={f.path}>
                          <span className="role-badge role-entry">入口</span>
                          <span className="arch-file-name">{f.path}</span>
                        </div>
                      ))}
                      {(indexSummary.entries || []).length === 0 && <div className="arch-none">未识别到入口</div>}
                    </div>
                    <div className="arch-col">
                      <div className="arch-col-title">核心文件（重要度 = 引用中心度 + 被引用 + 规模）</div>
                      {(indexSummary.topCore || []).map((f: any) => (
                        <div key={f.path} className="arch-file" onClick={() => { onOpenFile(f.path) }} title={`${f.path}\n被 ${f.importedBy?.length || 0} 个文件引用 · ${f.lines} 行`}>
                          <span className="arch-file-name">{f.path.replace(/^(src|lib|pkg)\//, '')}</span>
                          <span className="core-score-bar"><span style={{ width: `${f.score}%` }} /></span>
                          <span className="core-score">{f.score}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="toolbar-row">
                <input className="root-input" placeholder="新路线名称" value={newName} onChange={e => setNewName(e.target.value)} />
                <select className="template-select" value={templateId} onChange={e => setTemplateId(e.target.value as RouteTemplateId)} aria-label="路线模板">
                  {templates.length === 0 && <option value="codebase-onboarding">代码库入门模板</option>}
                  {templates.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
                </select>
                <button className="btn-secondary" onClick={createBlank} disabled={busy}>＋ 新建</button>
                <button className="btn-secondary" onClick={createAutoDraft} disabled={busy} title="基于代码索引：入口 → 核心文件（带行区间与说明）→ 示例">
                  {busy ? '索引分析中…' : '⚡ 智能路线（代码索引）'}
                </button>
              </div>
              {selectedTemplate && <p className="template-hint">{selectedTemplate.description} · {selectedTemplate.stages.join(' → ')}</p>}
              <ul className="routes-list">
                {routes.map(r => (
                    <li key={r.id} className={`route-item ${r.id === activeRouteId ? 'active' : ''}`}>
                      <div className="route-item-main" onClick={() => editExisting(r)} title="点击编辑步骤">
                        <span className="route-item-name">{routeLabels.get(r.id) || r.name}</span>
                        {r.is_default && <span className="badge-default">默认</span>}
                        <span className="route-item-meta">{r.steps.length} 步</span>
                      </div>
                      <div className="route-item-actions">
                        {!r.is_default && <button className="btn-mini" onClick={() => withBusy(async () => { await api.setDefaultRoute(course.id, r.id); await onRoutesChanged(r.id) }).then(() => notify('已设为默认'))}>设默认</button>}
                        <button className="btn-mini" onClick={() => withBusy(async () => { await api.duplicateRoute(course.id, r.id); await onRoutesChanged() }).then(() => notify('已复制'))}>复制</button>
                        <button className="btn-mini danger" onClick={() => { if (confirm(`删除路线「${routeDisplayName(r, templates)}」？进度将一并删除。`)) withBusy(async () => { await api.deleteRoute(course.id, r.id); await onRoutesChanged() }) }}>删除</button>
                      </div>
                    </li>
                ))}
                {routes.length === 0 && <li className="empty-root">暂无路线 —— 用上方「自动梳理草案」或「导入 md」开始</li>}
              </ul>
              <p className="hint">点击路线名进入步骤编辑器：排序 / 改说明 / 加检查点。</p>
            </div>
          )}

          {tab === 'list' && editRoute && (
            <div className="settings-section">
              <div className="toolbar-row">
                <input className="root-input" value={editRoute.name} onChange={e => setEditRoute({ ...editRoute, name: e.target.value })} />
                <button className="btn-primary" onClick={saveEdits} disabled={busy}>保存</button>
                <button className="btn-secondary" onClick={() => setEditRoute(null)}>返回</button>
              </div>
              <ul className="steps-edit-list">
                {editRoute.steps.map((s, i) => (
                  <li key={i} className="step-edit-item">
                    <div className="step-edit-row">
                      <span className="step-edit-idx">{i + 1}</span>
                      <select
                        value={s.type}
                        onChange={e => mutateSteps(st => { st[i].type = e.target.value as Step['type'] })}
                        className="step-edit-type"
                      >
                        <option value="file">文件</option>
                        <option value="doc">文档</option>
                        <option value="test">测试</option>
                        <option value="checkpoint">检查点</option>
                      </select>
                      <input
                        className="step-edit-title"
                        value={s.title}
                        placeholder="步骤标题"
                        onChange={e => mutateSteps(st => { st[i].title = e.target.value })}
                      />
                      <div className="step-edit-move">
                        <button className="btn-mini" onClick={() => moveStep(i, -1)}>↑</button>
                        <button className="btn-mini" onClick={() => moveStep(i, 1)}>↓</button>
                        <button className="btn-mini danger" onClick={() => mutateSteps(st => st.splice(i, 1))}>×</button>
                      </div>
                    </div>
                    {s.type !== 'checkpoint' && (
                      <div className="step-edit-row sub">
                        <input
                          className="step-edit-file grow2"
                          value={s.file || ''}
                          placeholder="文件路径（相对课程根，如 README.md）"
                          onChange={e => mutateSteps(st => { st[i].file = e.target.value || undefined })}
                        />
                        {s.file && (
                          <button
                            className="btn-mini"
                            title="校验文件是否存在"
                            onClick={async () => {
                              try {
                                await api.getFileContent(course.id, s.file!)
                                notify('文件存在 ✓')
                              } catch { notify('⚠ 文件不存在', 'err') }
                            }}
                          >校验</button>
                        )}
                        <input
                          className="step-edit-range"
                          value={s.range ? `${s.range[0]}-${s.range[1]}` : ''}
                          placeholder="行区间 48-180"
                          onChange={e => {
                            const m = e.target.value.match(/^(\d+)\s*-\s*(\d+)$/)
                            mutateSteps(st => { st[i].range = m ? [parseInt(m[1]), parseInt(m[2])] : undefined })
                          }}
                        />
                      </div>
                    )}
                    <textarea
                      className="step-edit-note"
                      rows={2}
                      value={s.note || ''}
                      placeholder="要点说明（阅读时显示在顶部横幅）"
                      onChange={e => mutateSteps(st => { st[i].note = e.target.value || undefined })}
                    />
                  </li>
                ))}
              </ul>
              <div className="toolbar-row">
                <button className="btn-secondary" onClick={() => mutateSteps(st => st.push({ id: `s${st.length + 1}-${Date.now()}`, type: 'file', title: '新步骤' }))}>＋ 文件步骤</button>
                <button className="btn-secondary" onClick={() => mutateSteps(st => st.push({ id: `s${st.length + 1}-${Date.now()}`, type: 'doc', title: '新文档步骤' }))}>＋ 文档步骤</button>
                <button className="btn-secondary" onClick={() => mutateSteps(st => st.push({ id: `s${st.length + 1}-${Date.now()}`, type: 'checkpoint', title: '里程碑检查点' }))}>＋ 检查点</button>
              </div>
            </div>
          )}

          {tab === 'import' && (
            <div className="settings-section">
              <p className="hint">把 Claude Code 预生成的指南 md（含 标题层级 + 文件路径/行号引用）导入为路线（FR-10②）。</p>
              <div className="form-group">
                <label>填充模板</label>
                <select className="root-input" value={templateId} onChange={e => setTemplateId(e.target.value as RouteTemplateId)}>
                  {templates.map(template => <option key={template.id} value={template.id}>{template.name} · {template.audience}</option>)}
                </select>
                {selectedTemplate && <p className="hint">导入内容会按阶段和槽位归类；缺少必填槽位会生成待填充步骤，不会把未定位的路径当成真实文件。</p>}
              </div>
              <div className="form-group">
                <label>目标课程</label>
                <input value={importTarget} onChange={e => setImportTarget(e.target.value)} className="root-input" />
              </div>
              <div className="form-group">
                <label>md 文件路径</label>
                <input value={importPath} onChange={e => setImportPath(e.target.value)} className="root-input" />
              </div>
              <div className="form-group">
                <label>章节标题（留空 = 整个文件）</label>
                <input value={importSection} onChange={e => setImportSection(e.target.value)} className="root-input" placeholder="如 Phase 2" />
              </div>
              <div className="form-group">
                <label>路线名称（留空自动取章节名）</label>
                <input value={importName} onChange={e => setImportName(e.target.value)} className="root-input" />
              </div>
              <button className="btn-primary" onClick={doImport} disabled={busy}>{busy ? '导入中…' : '导入为路线'}</button>
            </div>
          )}

          {tab === 'ai' && (
            <div className="settings-section">
              <p className="hint">需要已在设置页配置 AI Key（FR-29）。草案确认后才会落盘。</p>
              <div className="form-group">
                <label>填充模板</label>
                <select className="root-input" value={templateId} onChange={e => setTemplateId(e.target.value as RouteTemplateId)}>
                  {templates.map(template => <option key={template.id} value={template.id}>{template.name} · {template.audience}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>路线要求（可选）</label>
                <input value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} className="root-input" placeholder="如：面向 Python 开发者的精读路线" />
              </div>
              <button className="btn-primary" onClick={genAi} disabled={busy}>{busy ? '生成中…' : '生成草案'}</button>
              {aiDraft && (
                <div className="ai-draft">
                  <h4>草案预览（{aiDraft.length} 步）</h4>
                  {aiWarnings.length > 0 && (
                    <div className="draft-warnings">
                      <b>⚠ 自动修正 {aiWarnings.length} 项：</b>
                      <ul>{aiWarnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}</ul>
                    </div>
                  )}
                  <ol>
                    {aiDraft.map((s, i) => (
                      <li key={i}>
                        <span className={`step-type-badge type-${s.type}`}>{s.type}</span>
                        {s.stage && <span className="step-stage">{s.stage}</span>}
                        {s.title}
                        {s.file && <code className="draft-file">{s.file}{s.range ? ` L${s.range[0]}-${s.range[1]}` : ''}</code>}
                        <button className="btn-mini" onClick={() => setAiDraft(aiDraft.filter((_, j) => j !== i))}>移除</button>
                      </li>
                    ))}
                  </ol>
                  <button className="btn-primary" onClick={saveAiDraft}>保存为路线</button>
                  <button className="btn-secondary" onClick={() => { setAiDraft(null); setAiWarnings([]) }}>放弃</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
