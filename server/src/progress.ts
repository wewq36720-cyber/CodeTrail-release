import { run, getRow, getAll, withTransaction } from './db/index.js'
import { broadcast } from './ws.js'

const DAY = 24 * 60 * 60 * 1000

export function getProgress(routeId: string) {
  const rows = getAll('SELECT * FROM step_progress WHERE route_id = ?', [routeId])
  const map: Record<string, any> = {}
  for (const r of rows) map[r.step_id] = r
  return map
}

// FR-20/21：状态变更事务写入 + activities 追加（同事务）+ ws 广播
export function updateStepProgress(courseId: string, routeId: string, stepId: string, patch: {
  status?: 'todo' | 'doing' | 'done' | 'skipped'
  selfRating?: number
  self_rating?: number   // 前端 StepProgress 用蛇形；两种键都接受
  action?: string
}): any {
  const now = Date.now()

  const existing = getRow(
    'SELECT * FROM step_progress WHERE course_id = ? AND route_id = ? AND step_id = ?',
    [courseId, routeId, stepId]
  ) as any

  let status = patch.status
  const ratingIn = patch.selfRating !== undefined ? patch.selfRating : patch.self_rating
  let selfRating = ratingIn !== undefined ? ratingIn : existing?.self_rating
  let doneAt = existing?.done_at || null
  let reviewDueAt = existing?.review_due_at || null

  if (status === 'done' && existing?.status !== 'done') {
    doneAt = now
    reviewDueAt = now + 7 * DAY // 完成即设 7 天后到期（FR-21）
  }
  // 复习（重新置回进行中）：到期清空，进度历史留在 activities
  if (status === 'doing' && existing?.status === 'done') {
    doneAt = null
    reviewDueAt = null
  }

  const result = withTransaction(() => {
    if (existing) {
      run(`
        UPDATE step_progress SET
          status = COALESCE(?, status),
          self_rating = ?,
          last_open_at = ?,
          done_at = ?,
          review_due_at = ?
        WHERE course_id = ? AND route_id = ? AND step_id = ?
      `, [status ?? null, selfRating ?? null, now, doneAt, reviewDueAt, courseId, routeId, stepId])
    } else {
      run(`
        INSERT INTO step_progress (course_id, route_id, step_id, status, self_rating, last_open_at, done_at, review_due_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [courseId, routeId, stepId, status || 'doing', selfRating ?? null, now, doneAt, reviewDueAt])
    }

    run(`
      INSERT INTO activities (at, course_id, route_id, step_id, action, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [now, courseId, routeId, stepId, patch.action || 'progress_update', JSON.stringify({ status, selfRating })])

    return getRow('SELECT * FROM step_progress WHERE course_id = ? AND route_id = ? AND step_id = ?', [courseId, routeId, stepId])
  })

  broadcast({ type: 'progress', courseId, routeId, stepId, progress: result })
  return result
}

// FR-17：test 步骤最近一次通过自动置 ✓
export function autoCompleteTestStep(courseId: string, routeId: string, stepId: string) {
  const cur = getRow('SELECT status FROM step_progress WHERE course_id = ? AND route_id = ? AND step_id = ?', [courseId, routeId, stepId]) as any
  if (cur?.status === 'done') return cur
  return updateStepProgress(courseId, routeId, stepId, { status: 'done', action: 'test_passed' })
}
