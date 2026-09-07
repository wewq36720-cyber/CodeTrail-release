import type { DashboardData } from '../types'

interface DashboardProps {
  data: DashboardData | null
  onCourseClick: (courseId: string) => void
  /** 点路线 → 选中课程+该路线，回主界面看路线图 */
  onRouteClick: (courseId: string, routeId: string) => void
  onStartReview: (item: { course_id: string; route_id: string; step_id: string }) => void
}

function langTile(lang: string, kind: string): { text: string; cls: string } {
  const l = (lang || '').toLowerCase()
  if (l.includes('go')) return { text: 'GO', cls: 'go' }
  if (l.includes('py')) return { text: 'PY', cls: 'py' }
  if (kind === 'docs' || l.includes('md') || l.includes('doc')) return { text: 'MD', cls: 'md' }
  return { text: (l.slice(0, 2) || '··').toUpperCase(), cls: 'md' }
}

function typeDot(type: string): string {
  switch (type) {
    case 'test': return 'var(--red)'
    case 'doc': return 'var(--lang-md)'
    case 'checkpoint': return 'var(--amber)'
    default: return 'var(--lang-go)'
  }
}

/* 学习项目看板（dashboard 稿）：hero 大数字 × 课程榜单卡 × 三栏（下一步/复习/热力） */
export function Dashboard({ data, onCourseClick, onRouteClick, onStartReview }: DashboardProps) {
  if (!data) return <div className="dashboard-loading">加载看板数据…</div>

  const totalDone = data.courses.reduce((a, c) => a + c.totalDone, 0)
  const totalSteps = data.courses.reduce((a, c) => a + c.totalSteps, 0)
  const totalRoutes = data.courses.reduce((a, c) => a + c.routes.length, 0)
  const percent = totalSteps ? Math.round(data.courses.reduce((a, c) => a + c.totalDone, 0) / totalSteps * 100) : 0

  // 热力：补齐 30 天（无活动日为 0）
  const days: Array<{ day: string; count: number }> = []
  const countMap = new Map(data.heatmap.map(h => [h.day, h.count]))
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    days.push({ day: key, count: countMap.get(key) || 0 })
  }
  const maxCount = Math.max(1, ...days.map(d => d.count))
  const heatCls = (n: number) => n === 0 ? '' : n >= maxCount * 0.75 ? 'on' : n >= maxCount * 0.5 ? 'l3' : n >= maxCount * 0.25 ? 'l2' : 'l1'

  const courses = [...data.courses].sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0))

  return (
    <div className="dashboard">
      <div className="dash-wrap">
        <header className="hero">
          <h1><span className="logo">◈</span>学习项目看板</h1>
          <div className="total">{totalDone.toLocaleString()} <span className="star">✓</span></div>
          <div className="sub">累计完成步骤 · <b>{courses.length}</b> 门课程 · <b>{totalRoutes}</b> 条路线 · <b>{percent}%</b> 总进度</div>
        </header>

        <section className="board">
          {courses.map(({ course, routes, totalSteps: ts, totalDone: td }, idx) => {
            const lt = langTile(course.lang, course.kind)
            const pct = ts ? Math.round(td / ts * 100) : 0
            return (
              <article key={course.id} className="course" onClick={() => onCourseClick(course.id)}>
                <div className="c-top">
                  <div className={`c-icon ${lt.cls}`}>{lt.text}<span className="rank">{String(idx + 1).padStart(2, '0')}</span></div>
                  <div className="c-name">
                    <h3>{course.slug}</h3>
                    <p>{Number(course.missing) === 1 ? '⚠ 目录缺失' : (course.tags || []).join(' · ') || course.label}</p>
                  </div>
                  <div className="c-badges">
                    {ts > 0 && <span className="pill-s solid">★ {pct}%</span>}
                    <span className="pill-s ghost">{ts} 步</span>
                    {routes.length === 0 && <span className="pill-s warn">尚无路线</span>}
                  </div>
                </div>
                <div className="courses-routes">
                  {routes.length === 0 && <div className="rt-empty">打开课程后点顶栏「路线」创建「自动梳理路线」</div>}
                  {routes.map(route => (
                    <div
                      key={route.routeId}
                      className="rt"
                      title={`${route.routeLabel || route.routeName} · ${route.done}/${route.total} · 点击查看路线图`}
                      onClick={e => { e.stopPropagation(); onRouteClick(course.id, route.routeId) }}
                    >
                      <span className={`nm ${route.isDefault ? 'def' : ''}`}>{route.isDefault ? '★ ' : ''}{route.routeLabel || route.routeName}</span>
                      <span className="bar"><i style={{ width: `${route.percent}%` }} /></span>
                      <span className="pc">{route.done}/{route.total}</span>
                      <span className="next">{route.nextStep ? `下一步: ${route.nextStep.title}` : ''}</span>
                    </div>
                  ))}
                </div>
              </article>
            )
          })}
        </section>

        <section className="grid3">
          <div className="box">
            <h2>⏭ 下一步建议 <span className="tag">按最近活跃排序</span></h2>
            {data.nextSteps.length === 0 && <div className="rt-empty">暂无建议</div>}
            {data.nextSteps.slice(0, 8).map((item, i) => (
              <div key={i} className="item" onClick={() => onCourseClick(item.courseId)}>
                <i className="dot2" style={{ background: typeDot(item.type) }} />
                <span className="t">{item.courseName} · {item.routeLabel || item.routeName}{item.stage ? ` · ${item.stage}` : ''} · {item.title}</span>
                <span className="mini">{item.type === 'test' ? '测试' : item.type === 'doc' ? '文档' : '文件'}</span>
                <span className="go">继续 ▸</span>
              </div>
            ))}
          </div>

          <div className="box">
            <h2>🔄 复习队列 <span className="tag">自评 ≤3 或满 7 天</span></h2>
            {data.reviewQueue.length === 0 && <div className="rt-empty">暂无待复习步骤</div>}
            {data.reviewQueue.slice(0, 8).map(item => {
              const low = !!item.self_rating && item.self_rating <= 3
              return (
                <div key={`${item.course_id}-${item.route_id}-${item.step_id}`} className="item" onClick={() => onCourseClick(item.course_id)}>
                  <i className="dot2" style={{ background: low ? 'var(--red)' : 'var(--amber)' }} />
                  <span className="t">{item.course_slug} · {item.route_label || item.route_name}{item.stage ? ` · ${item.stage}` : ''} · {item.step_title}</span>
                  <span className={`mini ${low ? 'r3' : 'due'}`}>{low ? `自评 ${item.self_rating}` : '满 7 天'}</span>
                  <span
                    className="go"
                    onClick={e => { e.stopPropagation(); onStartReview({ course_id: item.course_id, route_id: item.route_id, step_id: item.step_id }) }}
                  >复习</span>
                </div>
              )
            })}
          </div>

          <div className="box">
            <h2>📅 近 30 天热力</h2>
            <div className="heat">
              {days.map(d => <i key={d.day} className={heatCls(d.count)} title={`${d.day}: ${d.count} 次活动`} />)}
            </div>
            <div className="heat-legend">
              少 <i style={{ background: 'var(--heat-0)' }} /><i style={{ background: 'var(--heat-1)' }} /><i style={{ background: 'var(--heat-2)' }} /><i style={{ background: 'var(--heat-3)' }} /><i style={{ background: 'var(--heat-4)' }} /> 多
            </div>
          </div>
        </section>

        <div className="dash-foot">CODETRAIL · LOCAL CODE LEARNING · {new Date().getFullYear()}</div>
      </div>
    </div>
  )
}
