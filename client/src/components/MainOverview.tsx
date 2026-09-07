import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { RouteTree } from './RouteTree'
import type { Course, Route, Step, StepProgress, DashboardData } from '../types'

interface MainOverviewProps {
  course: Course | undefined
  routes: Route[]
  selectedRouteId: string
  progress: Record<string, StepProgress>
  dashboardData: DashboardData | null
  onSelectRoute: (routeId: string) => void
  /** 点击路线步骤 / 任务 → 在 AI 界面打开该文件 */
  onStepOpen: (step: Step) => void
  onTaskOpen: (courseId: string, routeId: string, stepId: string) => void
  onAskAi: () => void
  onOpenRoutes: () => void
}

interface IndexSummary { topCore?: Array<{ path: string; score: number; lines: number }>; entries?: Array<{ path: string }>; stale?: boolean }

/* 主界面（展示型：速览 + 思维导图路线图 + 任务）；学习操作在 AI 界面 */
export function MainOverview({ course, routes, selectedRouteId, progress, dashboardData, onSelectRoute, onStepOpen, onTaskOpen, onAskAi, onOpenRoutes }: MainOverviewProps) {
  const [summary, setSummary] = useState<IndexSummary | null>(null)
  const route = routes.find(r => r.id === selectedRouteId)
  const steps = route?.steps || []
  const doneCount = steps.filter(s => ['done', 'skipped'].includes(progress[s.id]?.status || '')).length
  const percent = steps.length ? Math.round(doneCount / steps.length * 100) : 0

  useEffect(() => {
    if (!course) { setSummary(null); return }
    api.getIndexSummary(course.id).then(s => setSummary(s?.missing ? null : s)).catch(() => setSummary(null))
  }, [course?.id])

  const courseStat = dashboardData?.courses.find(c => c.course.id === course?.id)

  return (
    <div className="overview">
      {/* 项目速览 */}
      <section className="ov-panel">
        <div className="p-title">项目速览
          <span className="tag">{course ? `${course.slug} · ${course.lang}` : '未选择课程'}</span>
        </div>
        <div className="glance">
          <div className="cell">
            <div className="cell-h"><span className="ic">🗂</span><span><b>{routes.length} 条路线</b><small>{steps.length} 个步骤 · 当前 {percent}%</small></span></div>
          </div>
          <div className="cell">
            <div className="cell-h"><span className="ic">🧭</span><span><b>{(summary?.entries || []).length} 个入口</b><small>{(summary?.entries || [])[0]?.path || '未识别到启动入口'}</small></span></div>
          </div>
          <div className="cell">
            <div className="cell-h"><span className="ic">⭐</span><span><b>核心分 {summary?.topCore?.[0]?.score ?? '—'}</b><small>{summary?.topCore?.[0]?.path?.split('/').pop() || '构建索引后给出'}{summary?.stale ? ' · 索引过期' : ''}</small></span></div>
          </div>
          <div className="cell">
            <div className="cell-h"><span className="ic">✅</span><span><b>{courseStat ? `${courseStat.totalDone}/${courseStat.totalSteps}` : '—'}</b><small>累计完成步骤{courseStat?.lastActive ? ` · ${new Date(courseStat.lastActive).toLocaleDateString()} 活跃` : ''}</small></span></div>
          </div>
          <div className="cell">
            <div className="cell-h"><span className="ic">🔄</span><span><b>待复习 {dashboardData?.reviewQueue.length ?? 0}</b><small>自评 ≤3 或满 7 天</small></span></div>
          </div>
        </div>
        <div className="ov-actions">
          <button className="pill" onClick={onOpenRoutes}>🗺 管理路线 / 自动梳理</button>
          <button className="pill solid" onClick={onAskAi}>💬 问 AI（侧边代码助手）</button>
        </div>
      </section>

      {/* 学习路线树（可折叠 · 按阶段分组） */}
      <section className="ov-panel">
        <div className="p-title">学习路线树
          <span className="tag">点路线切换 · 点阶段折叠 · 点步骤进入 AI 界面学习</span>
        </div>
        <div className="rt-scroll">
          <RouteTree
            course={course}
            routes={routes}
            selectedRouteId={selectedRouteId}
            progress={progress}
            onStepOpen={onStepOpen}
            onSelectRoute={onSelectRoute}
          />
        </div>
      </section>

      {/* 任务呈现 */}
      <section className="ov-panel">
        <div className="p-title">任务呈现<span className="tag">下一步 · 复习队列</span></div>
        <div className="ov-tasks">
          <div className="ov-task-col">
            <div className="ov-col-title">⏭ 继续学习</div>
            {(dashboardData?.nextSteps || []).slice(0, 6).map((item, i) => (
              <div key={i} className="item" onClick={() => onTaskOpen(item.courseId, item.routeId, item.stepId)}>
                <i className="dot2" style={{ background: item.type === 'test' ? 'var(--red)' : item.type === 'doc' ? 'var(--lang-md)' : 'var(--lang-go)' }} />
                <span className="t">{item.courseName} · {item.routeLabel || item.routeName}{item.stage ? ` · ${item.stage}` : ''} · {item.title}</span>
                <span className="go">进入 ▸</span>
              </div>
            ))}
            {(dashboardData?.nextSteps || []).length === 0 && <div className="dock-empty">暂无待继续步骤</div>}
          </div>
          <div className="ov-task-col">
            <div className="ov-col-title">🔄 复习队列</div>
            {(dashboardData?.reviewQueue || []).slice(0, 6).map(item => {
              const low = !!item.self_rating && item.self_rating <= 3
              return (
                <div key={`${item.course_id}-${item.route_id}-${item.step_id}`} className="item" onClick={() => onTaskOpen(item.course_id, item.route_id, item.step_id)}>
                  <i className="dot2" style={{ background: low ? 'var(--red)' : 'var(--amber)' }} />
                  <span className="t">{item.course_slug} · {item.route_label || item.route_name}{item.stage ? ` · ${item.stage}` : ''} · {item.step_title}</span>
                  <span className={`mini ${low ? 'r3' : 'due'}`}>{low ? `自评 ${item.self_rating}` : '满 7 天'}</span>
                </div>
              )
            })}
            {(dashboardData?.reviewQueue || []).length === 0 && <div className="dock-empty">暂无待复习步骤</div>}
          </div>
        </div>
      </section>
    </div>
  )
}
