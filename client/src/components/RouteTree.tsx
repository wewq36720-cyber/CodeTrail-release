import { useMemo, useState } from 'react'
import type { Course, Route, Step, StepProgress } from '../types'

interface RouteTreeProps {
  course: Course | undefined
  routes: Route[]
  selectedRouteId: string
  progress: Record<string, StepProgress>
  onStepOpen: (step: Step) => void
  onSelectRoute: (routeId: string) => void
}

/* 分支六色循环（与文件树同一语义族） */
const BRANCH_VARS = ['--br-org', '--br-grn', '--br-blu', '--br-red', '--br-pur', '--br-amb']
const TYPE_ICON: Record<Step['type'], string> = { file: '📄', doc: '📘', test: '🧪', checkpoint: '◎' }

/** 按模板阶段分组（保持步骤出现顺序）：树层级 = 课程 → 路线 → 阶段 → 步骤 */
function groupByStage(steps: Step[]): Array<{ stage: string; steps: Step[] }> {
  const map = new Map<string, Step[]>()
  for (const s of steps) {
    const key = s.stage || '未分阶段'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }
  return [...map.entries()].map(([stage, list]) => ({ stage, steps: list }))
}

function stepStatus(s: Step, progress: Record<string, StepProgress>): 'done' | 'doing' | 'skipped' | 'todo' {
  const st = progress[s.id]?.status
  return st === 'done' || st === 'doing' || st === 'skipped' ? st : 'todo'
}

const STATUS_GLYPH: Record<string, string> = { done: '✓', doing: '▸', skipped: '⊘', todo: '○' }

/* 学习路线树：可折叠、按阶段分组、只显示选中路线的步骤 —— 大项目也能一眼看全 */
export function RouteTree({ course, routes, selectedRouteId, progress, onStepOpen, onSelectRoute }: RouteTreeProps) {
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set())
  const [collapsedRoutes, setCollapsedRoutes] = useState<Set<string>>(new Set())

  const sorted = useMemo(
    () => [...routes].sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) || a.order - b.order),
    [routes]
  )

  if (!course) return null

  if (routes.length === 0) {
    return <div className="dock-empty" style={{ padding: 24, textAlign: 'center' }}>该课程还没有路线 —— 点上方「🗺 管理路线」用代码索引自动梳理，或按模板创建。</div>
  }

  function toggle(set: Set<string>, key: string, apply: (next: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    apply(next)
  }

  return (
    <div className="route-tree">
      <div className="rt2-root mono">
        <span className="name">{course.slug}</span>
        <span className="lang">{(course.lang || '').toUpperCase()}</span>
        <span className="cnt">{routes.length} 条路线</span>
      </div>

      {sorted.map((route, ri) => {
        const bc = `var(${BRANCH_VARS[ri % BRANCH_VARS.length]})`
        const selected = route.id === selectedRouteId
        const collapsed = collapsedRoutes.has(route.id)
        const done = route.steps.filter(s => stepStatus(s, progress) === 'done').length
        const groups = groupByStage(route.steps)
        return (
          <div key={route.id} className={`rt2-route ${selected ? 'sel' : ''}`}>
            <div className="rt2-route-row" onClick={() => { onSelectRoute(route.id); setCollapsedRoutes(prev => { const n = new Set(prev); n.delete(route.id); return n }) }}>
              <button
                className="rt2-twisty"
                onClick={e => { e.stopPropagation(); toggle(collapsedRoutes, route.id, setCollapsedRoutes) }}
                title={collapsed ? '展开步骤' : '折叠步骤'}
                aria-label="展开/折叠路线"
              >{selected && !collapsed ? '▾' : '▸'}</button>
              <span className="rt2-dot" style={{ background: bc }} />
              <span className="rt2-route-name" title={`${route.name} · ${route.steps.length} 步`}>
                {route.is_default ? '★ ' : ''}{route.name}
              </span>
              <span className="rt2-bar"><i style={{ width: `${route.steps.length ? Math.round(done / route.steps.length * 100) : 0}%`, background: bc }} /></span>
              <span className="rt2-cnt">{done}/{route.steps.length}</span>
            </div>

            {selected && !collapsed && groups.map(g => {
              const gDone = g.steps.filter(s => stepStatus(s, progress) === 'done').length
              const stageKey = `${route.id}::${g.stage}`
              const stageCollapsed = collapsedStages.has(stageKey)
              return (
                <div key={stageKey} className="rt2-stage">
                  <div className="rt2-stage-row" onClick={() => toggle(collapsedStages, stageKey, setCollapsedStages)}>
                    <span className="rt2-twisty">{stageCollapsed ? '▸' : '▾'}</span>
                    <span className="rt2-stage-name">🗂 {g.stage}</span>
                    <span className="rt2-cnt dim">{gDone}/{g.steps.length}</span>
                  </div>
                  {!stageCollapsed && g.steps.map(s => {
                    const st = stepStatus(s, progress)
                    return (
                      <button
                        key={s.id}
                        className={`rt2-leaf st-${st}`}
                        style={{ ['--bc' as string]: bc }}
                        onClick={() => onStepOpen(s)}
                        title={`${s.title}\n${s.file || ''}${s.range ? ` L${s.range[0]}-${s.range[1]}` : ''}\n${s.note || ''}\n点击 → 在 AI 界面学习`}
                      >
                        <span className={`rt2-st ${st}`}>{STATUS_GLYPH[st]}</span>
                        <span className="rt2-ico">{TYPE_ICON[s.type]}</span>
                        <span className="rt2-txt">
                          {s.title.replace(/^[^：]+：/, '')}
                          {s.file && <span className="rt2-com"> # {s.file.split('/').pop()}{s.range ? `:L${s.range[0]}` : ''}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
