import { getAll } from './db/index.js'
import { getCourses, getCourseById } from './scanner.js'
import { getRoutes, type Route } from './routes.js'
import { getProgress } from './progress.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export function getActivities(query: any = {}) {
  let sql = 'SELECT * FROM activities WHERE 1=1'
  const params: any[] = []

  if (query.courseId) { sql += ' AND course_id = ?'; params.push(query.courseId) }
  if (query.routeId) { sql += ' AND route_id = ?'; params.push(query.routeId) }
  if (query.since) { sql += ' AND at > ?'; params.push(query.since) }

  sql += ' ORDER BY at DESC'
  if (query.limit) { sql += ' LIMIT ?'; params.push(query.limit) }
  return getAll(sql, params)
}

function stepMetaOf(routeId: string, stepId: string): { title: string; stage?: string } {
  const row = getAll('SELECT def_path FROM routes WHERE id = ?', [routeId])[0] as any
  if (!row?.def_path || !existsSync(row.def_path)) return { title: stepId }
  try {
    const def = JSON.parse(readFileSync(row.def_path, 'utf8'))
    const step = (def.steps || []).find((s: any) => s.id === stepId)
    return { title: step?.title || stepId, stage: step?.stage }
  } catch { return { title: stepId } }
}

function routeLabels(routes: Route[]): Map<string, string> {
  const templateNames: Record<string, string> = {
    'codebase-onboarding': '代码库入门',
    'feature-trace': '功能链路',
    'bug-investigation': '故障排查',
    'api-integration': 'API 集成',
    'project-decomposition': '项目拆解',
    'example-driven': '示例驱动',
    'deep-module': '模块精读'
  }
  // 语义化描述：模板名 + 首个文件步骤所在目录（同名路线靠它区分，不再一排「智能路线」）
  const focusOf = (route: Route): string => {
    const file = route.steps.find(step => step.file)?.file || ''
    const segs = file.split('/')
    return segs.length > 1 ? segs[segs.length - 2] : ''
  }
  const counts = new Map<string, number>()
  const descriptors = new Map<string, string>()
  for (const route of routes) {
    const template = route.templateId && templateNames[route.templateId]
    const focus = focusOf(route)
    const firstStage = route.steps.find(step => step.stage)?.stage
    const firstTitle = route.steps.find(step => step.title)?.title?.replace(/^.+?：/, '').trim()
    const base = template || firstStage || firstTitle?.slice(0, 18) || '未分类路线'
    const descriptor = focus ? `${base} · ${focus}/` : base
    descriptors.set(route.id, descriptor)
    const displayName = route.name && !route.name.includes('\uFFFD') ? route.name : template || '未命名路线'
    const key = displayName === descriptor ? displayName : `${displayName} · ${descriptor}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const labels = new Map<string, string>()
  for (const route of routes) {
    const descriptor = descriptors.get(route.id) || '未分类路线'
    const displayName = route.name && !route.name.includes('\uFFFD') ? route.name : route.templateId && templateNames[route.templateId] || '未命名路线'
    const key = displayName === descriptor ? displayName : `${displayName} · ${descriptor}`
    const suffix = (counts.get(key) || 0) > 1 ? ` · #${String(routes.indexOf(route) + 1).padStart(2, '0')}` : ''
    labels.set(route.id, `${key}${suffix}`)
  }
  return labels
}

export function getDashboard() {
  const courses = getCourses().filter(course => Number(course.missing) !== 1 && getRoutes(course.id).length > 0)
  const result = []

  for (const course of courses) {
    const routes = getRoutes(course.id)
    const labels = routeLabels(routes)
    const routeProgress = []

    for (const route of routes) {
      const progress = Object.values(getProgress(route.id)) as any[]
      const total = route.steps.length
      const done = progress.filter(p => p.status === 'done').length
      const doing = progress.filter(p => p.status === 'doing').length

      let nextStep = null
      for (const step of route.steps) {
        const p = progress.find(x => x.step_id === step.id)
        if (!p || p.status === 'todo') {
          nextStep = { stepId: step.id, title: step.title, type: step.type, stage: step.stage }
          break
        }
      }

      routeProgress.push({
        routeId: route.id,
        routeName: route.name,
        routeLabel: labels.get(route.id) || route.name,
        isDefault: !!route.is_default,
        total,
        done,
        doing,
        percent: total > 0 ? Math.round((done / total) * 100) : 0,
        nextStep
      })
    }

    const recentActivity = getActivities({ courseId: course.id, limit: 10 })
    const lastActive = recentActivity[0]?.at || course.last_scan_at

    result.push({
      course,
      routes: routeProgress,
      lastActive,
      totalSteps: routeProgress.reduce((a, r) => a + r.total, 0),
      totalDone: routeProgress.reduce((a, r) => a + r.done, 0)
    })
  }

  return {
    courses: result,
    heatmap: getHeatmapData(),
    reviewQueue: getReviewQueue(),
    nextSteps: result.flatMap(c => c.routes.filter(r => r.nextStep).map(r => ({
      ...r.nextStep!, courseId: c.course.id, courseName: c.course.slug, routeId: r.routeId, routeName: r.routeName, routeLabel: r.routeLabel
    })))
  }
}

function getHeatmapData() {
  // 近 30 天按天聚合，升序返回（前端按日期铺格子）
  const rows = getAll(`
    SELECT date(at/1000, 'unixepoch', 'localtime') as day, COUNT(*) as count
    FROM activities
    WHERE at > ?
    GROUP BY day
    ORDER BY day ASC
  `, [Date.now() - 30 * 24 * 60 * 60 * 1000])
  return rows
}

// FR-21：自评 ≤3 立即入队，或完成满 7 天到期
function getReviewQueue() {
  const rows = getAll(`
    SELECT sp.*, r.name as route_name, c.slug as course_slug, c.id as course_id
    FROM step_progress sp
    JOIN routes r ON sp.route_id = r.id
    JOIN courses c ON sp.course_id = c.id
    WHERE sp.status = 'done' AND (sp.self_rating IS NOT NULL AND sp.self_rating <= 3 OR sp.review_due_at IS NOT NULL AND sp.review_due_at < ?)
    ORDER BY COALESCE(sp.review_due_at, sp.done_at) ASC
    LIMIT 20
  `, [Date.now()]) as any[]

  return rows.map(r => {
    const courseRoutes = getRoutes(r.course_id)
    const route = courseRoutes.find(item => item.id === r.route_id)
    const meta = stepMetaOf(r.route_id, r.step_id)
    return {
      ...r,
      route_label: route ? routeLabels(courseRoutes).get(route.id) : r.route_name,
      step_title: meta.title,
      stage: meta.stage
    }
  })
}
