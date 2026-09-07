import { useCallback, useEffect, useRef, useState } from 'react'
import { Header } from './components/Header'
import { AiView } from './components/AiView'
import { AiChat } from './components/AiChat'
import { MainOverview } from './components/MainOverview'
import { Dashboard } from './components/Dashboard'
import { SettingsModal } from './components/SettingsModal'
import { RoutesModal } from './components/RoutesModal'
import { api } from './lib/api'
import type { Course, Route, Step, StepProgress, DashboardData, OpenRequest } from './types'

type View = 'main' | 'dashboard' | 'ai'

function App() {
  const [view, setView] = useState<View>('main')
  const [courses, setCourses] = useState<Course[]>([])
  const [selectedCourseId, setSelectedCourseId] = useState<string>('')
  const [routes, setRoutes] = useState<Route[]>([])
  const [selectedRouteId, setSelectedRouteId] = useState<string>('')
  const [progress, setProgress] = useState<Record<string, StepProgress>>({})
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [routesOpen, setRoutesOpen] = useState(false)
  const [aiSide, setAiSide] = useState(false)
  const [openReq, setOpenReq] = useState<OpenRequest | null>(null)
  const [editorSignal, setEditorSignal] = useState<{ type: 'check' | 'preview'; ts: number } | null>(null)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)
  const [bootError, setBootError] = useState<string>('')
  const [connected, setConnected] = useState(true)
  const toastTimer = useRef<number | null>(null)

  // 连接状态监测：后端断开时给出可见提示（避免「点了没反应」的静默失败）
  useEffect(() => {
    const probe = async () => {
      try {
        await api.getCourses()
        setConnected(true)
      } catch {
        setConnected(false)
      }
    }
    probe()
    const timer = window.setInterval(probe, 5000)
    return () => window.clearInterval(timer)
  }, [])

  // 验收 / 分享深链：?view=dashboard|ai · ?aiside=1 · ?settings=ui · ?course= · ?file=（见下方两个 effect）
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    const v = q.get('view')
    if (v === 'dashboard' || v === 'ai') setView(v)
    if (q.get('aiside')) setAiSide(true)
    if (q.get('settings')) setSettingsOpen(true)
  }, [])

  function notify(text: string, kind: 'ok' | 'err' = 'ok') {
    setToast({ text, kind })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  useEffect(() => {
    loadInitialData()
    // WS：进度实时同步（多标签页 / 执行结果广播）
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let ws: WebSocket | null = null
    let closed = false
    const connect = () => {
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'progress' && msg.routeId === selectedRouteId && msg.progress) {
            setProgress(prev => ({ ...prev, [msg.stepId]: msg.progress }))
          }
        } catch {}
      }
      ws.onclose = () => { if (!closed) setTimeout(connect, 3000) }
    }
    connect()
    return () => { closed = true; ws?.close() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadInitialData() {
    try {
      const list = await api.getCourses()
      setCourses(list)
      if (list.length > 0) {
        // 深链 ?course= 优先（E2E 复盘缺陷③：在唯一初始化入口决定课程，杜绝被默认选择覆盖的竞态）
        const wanted = new URLSearchParams(location.search).get('course') || ''
        const hit = wanted ? list.find(c => c.id === wanted) : undefined
        if (hit) {
          await selectCourse(hit.id)
        } else {
          // 首屏优先落在有路线的课程上（避免默认停在没有路线的课程显得「没内容可点」）
          let chosen = list[0]
          for (const c of list) {
            try {
              const rs = await api.getRoutes(c.id)
              if (rs.length > 0) { chosen = c; break }
            } catch {}
          }
          await selectCourse(chosen.id)
        }
      }
      const dash = await api.getDashboard()
      setDashboardData(dash)
    } catch (e: any) {
      setBootError(`无法连接后端（${e.message}）。请通过 start.bat 启动或检查 8787 端口。`)
    }
  }

  async function refreshDashboard() {
    try { setDashboardData(await api.getDashboard()) } catch {}
  }

  async function selectCourse(courseId: string, routeId?: string) {
    setSelectedCourseId(courseId)
    setSelectedRouteId('')
    setProgress({})
    try {
      const list = await api.getRoutes(courseId)
      setRoutes(list)
      const target = (routeId && list.find(r => r.id === routeId)) || list.find(r => r.is_default) || list[0]
      if (target) await selectRoute(target.id)
      else setProgress({})
    } catch (e: any) {
      notify(`加载路线失败: ${e.message}`, 'err')
    }
  }

  async function selectRoute(routeId: string) {
    setSelectedRouteId(routeId)
    try {
      const prog = await api.getRouteProgress(routeId)
      setProgress(prog || {})
    } catch {
      setProgress({})
    }
  }

  const openFile = useCallback((path: string, opts?: { range?: [number, number]; note?: string; stepId?: string }) => {
    setOpenReq({ path, range: opts?.range, note: opts?.note, stepId: opts?.stepId, ts: Date.now() })
  }, [])

  // 深链 ?course= 已在 loadInitialData 内统一处理（缺陷③：避免被默认选择竞态覆盖）
  // 深链 ?file= ：首屏课程（含 ?course= 指定）就绪后自动打开
  const fileParam = useRef(new URLSearchParams(location.search).get('file') || '')
  useEffect(() => {
    if (fileParam.current && selectedCourseId) {
      openFile(fileParam.current)
      fileParam.current = ''
    }
  }, [selectedCourseId, openFile])

  /** 步骤 → 在 AI 界面打开对应文件（学习主场景） */
  const openStepInAi = useCallback((step: Step) => {
    if (step.file) openFile(step.file, { range: step.range, note: step.note, stepId: step.id })
    setView('ai')
  }, [openFile])

  /** 任务（看板 / 主界面任务列）→ 选课程 + 路线，进入 AI 界面并打开步骤 */
  async function openTask(courseId: string, routeId: string, stepId: string) {
    if (courseId !== selectedCourseId) await selectCourse(courseId, routeId)
    else if (routeId !== selectedRouteId) await selectRoute(routeId)
    const r = routes.find(x => x.id === routeId)
    const step = r?.steps.find(s => s.id === stepId)
    if (step) openStepInAi(step)
    else setView('ai')
    refreshDashboard()
  }

  async function handleProgressChange(stepId: string, patch: Partial<StepProgress>) {
    if (!selectedCourseId || !selectedRouteId) return
    // 乐观更新 + API 落库（失败回滚提示）
    const prev = progress[stepId]
    setProgress(p => ({ ...p, [stepId]: { ...(p[stepId] || { course_id: selectedCourseId, route_id: selectedRouteId, step_id: stepId, status: 'todo' } as StepProgress), ...patch } as StepProgress }))
    try {
      const updated = await api.updateStepProgress(selectedCourseId, selectedRouteId, stepId, patch)
      if (updated) setProgress(p => ({ ...p, [stepId]: updated }))
      refreshDashboard()
    } catch (e: any) {
      if (prev) setProgress(p => ({ ...p, [stepId]: prev }))
      notify(`进度保存失败: ${e.message}`, 'err')
    }
  }

  async function handleStartReview(item: { course_id: string; route_id: string; step_id: string }) {
    try {
      await api.updateStepProgress(item.course_id, item.route_id, item.step_id, { status: 'doing' })
      await openTask(item.course_id, item.route_id, item.step_id)
      notify('已置回进行中，开始复习')
    } catch (e: any) {
      notify(`复习操作失败: ${e.message}`, 'err')
    }
  }

  if (bootError) {
    return (
      <div className="app-loading">
        <p style={{ color: 'var(--red)' }}>⚠ {bootError}</p>
      </div>
    )
  }

  const selectedCourse = courses.find(c => c.id === selectedCourseId)
  const selectedRoute = routes.find(r => r.id === selectedRouteId)

  return (
    <div className="app">
      {!connected && (
        <div className="conn-banner">
          ⚠ 后端服务未连接——界面操作无法保存。请运行 app\start.bat 启动服务后刷新本页（服务地址 http://127.0.0.1:8787）。
        </div>
      )}
      <Header
        view={view}
        setView={setView}
        courses={courses}
        selectedCourseId={selectedCourseId}
        routeCount={routes.length}
        onCourseChange={id => selectCourse(id)}
        onSettingsClick={() => setSettingsOpen(true)}
        onRoutesClick={async () => {
          // 打开前刷新路线列表，避免外部变更导致数据过期
          if (selectedCourseId) {
            try { setRoutes(await api.getRoutes(selectedCourseId)) } catch {}
          }
          setRoutesOpen(true)
        }}
        onCheckClick={() => { setView('ai'); setEditorSignal({ type: 'check', ts: Date.now() }) }}
        onPreviewClick={() => { setView('ai'); setEditorSignal({ type: 'preview', ts: Date.now() }) }}
      />

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          notify={notify}
          onRescan={async () => {
            const r = await api.scan()
            const list = await api.getCourses()
            setCourses(list)
            notify(`扫描完成，共 ${r.courses} 门课程`)
          }}
        />
      )}

      {routesOpen && selectedCourse && (
        <RoutesModal
          course={selectedCourse}
          routes={routes}
          activeRouteId={selectedRouteId}
          onClose={() => setRoutesOpen(false)}
          onRoutesChanged={async (activateRouteId?: string) => {
            const list = await api.getRoutes(selectedCourse.id)
            setRoutes(list)
            if (activateRouteId) await selectRoute(activateRouteId)
            else if (list.length && !list.find(r => r.id === selectedRouteId)) await selectRoute((list.find(r => r.is_default) || list[0]).id)
            refreshDashboard()
          }}
          onOpenFile={path => { setRoutesOpen(false); openFile(path); setView('ai') }}
          notify={notify}
        />
      )}

      <main className="main-layout">
        {view === 'dashboard' && (
          <Dashboard
            data={dashboardData}
            onCourseClick={id => selectCourse(id)}
            onRouteClick={(courseId, routeId) => { selectCourse(courseId, routeId); setView('main') }}
            onStartReview={handleStartReview}
          />
        )}

        {view === 'ai' && (
          <AiView
            course={selectedCourse}
            route={selectedRoute}
            progress={progress}
            openReq={openReq}
            signal={editorSignal}
            routeFiles={(selectedRoute?.steps || []).filter(s => s.file).map(s => s.file!)}
            onOpenFile={openFile}
            onProgressChange={handleProgressChange}
          />
        )}

        {view === 'main' && (
          <>
            <div className="pane pane-overview">
              <MainOverview
                course={selectedCourse}
                routes={routes}
                selectedRouteId={selectedRouteId}
                progress={progress}
                dashboardData={dashboardData}
                onSelectRoute={selectRoute}
                onStepOpen={openStepInAi}
                onTaskOpen={openTask}
                onAskAi={() => setAiSide(true)}
                onOpenRoutes={async () => {
                  if (selectedCourseId) {
                    try { setRoutes(await api.getRoutes(selectedCourseId)) } catch {}
                  }
                  setRoutesOpen(true)
                }}
              />
            </div>
            {aiSide && (
              <aside className="pane ai-side" style={{ width: 380 }}>
                <AiChat
                  variant="side"
                  course={selectedCourse}
                  route={selectedRoute}
                  progress={progress}
                  onClose={() => setAiSide(false)}
                  onExpand={() => { setAiSide(false); setView('ai') }}
                />
              </aside>
            )}
          </>
        )}
      </main>

      {toast && <div className={`toast ${toast.kind === 'ok' ? 'success' : 'error'}`}>{toast.text}</div>}
    </div>
  )
}

export default App
