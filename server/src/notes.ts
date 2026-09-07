import { run, getRow, getAll } from './db/index.js'
import { getLddPath } from './db/index.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'

const NOTES_DIR = join(getLddPath(), 'notes')
mkdirSync(NOTES_DIR, { recursive: true })

export function getNotes(courseId?: string, stepId?: string) {
  let query = 'SELECT * FROM notes'
  const params: any[] = []
  if (courseId || stepId) {
    query += ' WHERE '
    const conditions = []
    if (courseId) { conditions.push('course_id = ?'); params.push(courseId) }
    if (stepId) { conditions.push('step_id = ?'); params.push(stepId) }
    query += conditions.join(' AND ')
  }
  query += ' ORDER BY updated_at DESC'
  const rows = getAll(query, params) as any[]
  // 附带正文（步骤内嵌笔记为单文件小内容）
  for (const r of rows) {
    try { r.__content = readFileSync(join(NOTES_DIR, `${r.id}.md`), 'utf8') } catch { r.__content = '' }
  }
  return rows
}

// Windows 文件名安全清洗（课程 id 含 ':'）
function safeName(s: string) {
  return s.replace(/[\\/:*?"<>|]/g, '__')
}

export function saveNote(data: { courseId: string; stepId?: string; title: string; content: string; filePath?: string; rangeStart?: number; rangeEnd?: number }): any {
  const now = Date.now()
  // 固定 id = 课程+步骤（同一步骤的笔记为一条，可反复更新）
  const id = safeName(`${data.courseId}__${data.stepId || 'global'}`)

  const notePath = join(NOTES_DIR, `${id}.md`)
  writeFileSync(notePath, data.content, 'utf8')

  const existing = getRow('SELECT * FROM notes WHERE id = ?', [id])
  if (existing) {
    run('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?', [data.title, now, id])
  } else {
    run('INSERT INTO notes (id, course_id, step_id, title, updated_at, file_path, range_start, range_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, data.courseId, data.stepId || null, data.title, now, data.filePath || null, data.rangeStart || null, data.rangeEnd || null])
  }

  return { id, ...data, updatedAt: now }
}

export function deleteNote(id: string) {
  const notePath = join(NOTES_DIR, `${id}.md`)
  if (existsSync(notePath)) unlinkSync(notePath)
  run('DELETE FROM notes WHERE id = ?', [id])
}

// 全平台笔记检索（FR-22）：标题 + 正文关键词
export function searchNotes(query: string) {
  if (!query) return []
  const notes = getAll('SELECT * FROM notes ORDER BY updated_at DESC') as any[]
  const q = query.toLowerCase()
  const results = []
  for (const note of notes) {
    let content = ''
    try { content = readFileSync(join(NOTES_DIR, `${note.id}.md`), 'utf8') } catch {}
    const idx = content.toLowerCase().indexOf(q)
    if (note.title?.toLowerCase().includes(q) || idx !== -1) {
      const snippet = idx !== -1
        ? content.slice(Math.max(0, idx - 40), idx + 120)
        : content.slice(0, 160)
      results.push({ ...note, snippet })
    }
    if (results.length >= 50) break
  }
  return results
}