import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, cpSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// LDD（平台数据目录）：默认 <工作区根>/.learndesk（04 §3 约定），可用 LEARNDESK_DIR 覆盖。
// src/db → 上溯 4 级 = 工作区根；dist/db 同样 4 级。
const LDD = process.env.LEARNDESK_DIR || join(__dirname, '../../../..', '.learndesk')
const LEGACY_LDD = join(__dirname, '../../../..', 'app/server/.learndesk')

mkdirSync(LDD, { recursive: true })
for (const sub of ['routes', 'tests', 'notes', 'tmp', 'preview', 'backups']) {
  mkdirSync(join(LDD, sub), { recursive: true })
}

// 一次性迁移：旧实现把 LDD 放在 app/server/.learndesk，搬到这里（保留原目录不动）
if (!existsSync(join(LDD, 'db.sqlite')) && existsSync(join(LEGACY_LDD, 'db.sqlite'))) {
  for (const item of ['db.sqlite', 'settings.json', 'routes', 'tests', 'notes', 'backups']) {
    const src = join(LEGACY_LDD, item)
    if (existsSync(src)) {
      try { cpSync(src, join(LDD, item), { recursive: true }) } catch {}
    }
  }
}

const DB_PATH = join(LDD, 'db.sqlite')

let db: DatabaseSync | null = null

export function getDatabase(): DatabaseSync {
  if (!db) throw new Error('Database not initialized')
  return db
}

export async function initDatabase() {
  db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  initSchema()
}

export function closeDatabase() {
  if (db) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}
    db.close()
    db = null
  }
}

export function reopenDatabase() {
  closeDatabase()
  return initDatabase()
}

function initSchema() {
  if (!db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      kind TEXT,
      root TEXT,
      slug TEXT,
      lang TEXT,
      label TEXT,
      tags TEXT,
      scan_meta TEXT,
      missing INTEGER DEFAULT 0,
      last_scan_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      course_id TEXT REFERENCES courses(id),
      name TEXT,
      def_path TEXT,
      "order" INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS step_progress (
      course_id TEXT,
      route_id TEXT,
      step_id TEXT,
      status TEXT DEFAULT 'todo',
      self_rating INTEGER,
      last_open_at INTEGER,
      done_at INTEGER,
      review_due_at INTEGER,
      PRIMARY KEY (course_id, route_id, step_id)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER,
      course_id TEXT,
      route_id TEXT,
      step_id TEXT,
      action TEXT,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_act_at ON activities(at);
    CREATE INDEX IF NOT EXISTS idx_act_course ON activities(course_id);

    CREATE TABLE IF NOT EXISTS settings (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      course_id TEXT,
      step_id TEXT,
      title TEXT,
      updated_at INTEGER,
      file_path TEXT,
      range_start INTEGER,
      range_end INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_notes_course ON notes(course_id);
    CREATE INDEX IF NOT EXISTS idx_notes_step ON notes(step_id);
  `)
  migrateSchema()
}

// 旧库补列（CREATE TABLE IF NOT EXISTS 不会改已有表结构）
function migrateSchema() {
  if (!db) return
  const cols = db.prepare("PRAGMA table_info(courses)").all() as any[]
  if (!cols.some(c => c.name === 'missing')) {
    db.exec('ALTER TABLE courses ADD COLUMN missing INTEGER DEFAULT 0')
  }
  const rcols = db.prepare("PRAGMA table_info(routes)").all() as any[]
  if (!rcols.some(c => c.name === 'is_default')) {
    db.exec('ALTER TABLE routes ADD COLUMN is_default INTEGER DEFAULT 0')
  }
  if (!rcols.some(c => c.name === 'order')) {
    db.exec('ALTER TABLE routes ADD COLUMN "order" INTEGER DEFAULT 0')
  }
  const ncols = db.prepare("PRAGMA table_info(notes)").all() as any[]
  if (!ncols.some(c => c.name === 'file_path')) db.exec('ALTER TABLE notes ADD COLUMN file_path TEXT')
  if (!ncols.some(c => c.name === 'range_start')) db.exec('ALTER TABLE notes ADD COLUMN range_start INTEGER')
  if (!ncols.some(c => c.name === 'range_end')) db.exec('ALTER TABLE notes ADD COLUMN range_end INTEGER')
}

export function getLddPath() {
  return LDD
}

// node:sqlite 对 undefined 参数会抛错，统一归一为 null
function norm(params: any[]): any[] {
  return params.map(p => (p === undefined ? null : p))
}

export function run(sql: string, params: any[] = []) {
  if (!db) throw new Error('Database not initialized')
  const stmt = db.prepare(sql)
  const info = stmt.run(...norm(params))
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
}

export function runExec(sql: string) {
  if (!db) throw new Error('Database not initialized')
  db.exec(sql)
}

export function getRow(sql: string, params: any[] = []) {
  if (!db) throw new Error('Database not initialized')
  const stmt = db.prepare(sql)
  const row = stmt.get(...norm(params)) as any
  return row || null
}

export function getAll(sql: string, params: any[] = []) {
  if (!db) throw new Error('Database not initialized')
  const stmt = db.prepare(sql)
  return stmt.all(...norm(params)) as any[]
}

export function withTransaction<T>(fn: () => T): T {
  if (!db) throw new Error('Database not initialized')
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
