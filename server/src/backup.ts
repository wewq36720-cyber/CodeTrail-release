import { getLddPath, getDatabase, reopenDatabase } from './db/index.js'
import { mkdirSync, existsSync, rmSync, readdirSync, statSync, renameSync, cpSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'

const LDD = getLddPath()
const BACKUP_DIR = join(LDD, 'backups')
mkdirSync(BACKUP_DIR, { recursive: true })

// FR-31：导出快照 = db + routes + tests + notes 打包 zip（settings 与 tmp 排除）
export function exportBackup(): { file: string; size: number } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const zipName = `codetrail-backup-${timestamp}.zip`
  const zipPath = join(BACKUP_DIR, zipName)

  // WAL 落盘后再打包，保证 db.sqlite 完整
  try { getDatabase().exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch {}

  const items = ['db.sqlite', 'routes', 'tests', 'notes'].filter(i => existsSync(join(LDD, i)))
  if (items.length === 0) throw new Error('没有可备份的数据')

  // bsdtar（Windows 自带）-a 按扩展名生成 zip；
  // 全部用相对路径 + cwd，避免盘符冒号被 tar 当作远程主机
  const relName = `backups/${zipName}`
  execFileSync('tar', ['-a', '-c', '-f', relName, ...items], { cwd: LDD, timeout: 60000, windowsHide: true })

  const size = statSync(zipPath).size
  return { file: zipName, size }
}

export function importBackup(body: { file: string }): { ok: boolean; message: string } {
  const zipPath = join(BACKUP_DIR, body.file)
  if (!body.file.includes('..') && existsSync(zipPath) === false) {
    return { ok: false, message: '备份文件不存在' }
  }
  if (body.file.includes('..')) {
    return { ok: false, message: '非法文件名' }
  }

  const staging = join(LDD, `import-${randomUUID().slice(0, 8)}`)
  mkdirSync(staging, { recursive: true })

  try {
    execFileSync('tar', ['-xf', zipPath], { cwd: staging, timeout: 120000, windowsHide: true })
    if (!existsSync(join(staging, 'db.sqlite'))) {
      return { ok: false, message: '备份包中缺少 db.sqlite，不是有效的 CodeTrail 备份' }
    }

    // 覆盖前备份原库（FR-31）
    const dbDst = join(LDD, 'db.sqlite')
    if (existsSync(dbDst)) {
      renameSync(dbDst, join(LDD, `db.sqlite.pre-import.${Date.now()}`))
    }
    cpSync(join(staging, 'db.sqlite'), dbDst)

    for (const dir of ['routes', 'tests', 'notes']) {
      const src = join(staging, dir)
      const dst = join(LDD, dir)
      if (existsSync(src)) {
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
        cpSync(src, dst, { recursive: true })
      }
    }

    // 重新打开数据库连接加载新库
    reopenDatabase()
    return { ok: true, message: '导入成功，数据已切换' }
  } catch (e: any) {
    try { reopenDatabase() } catch {}
    return { ok: false, message: `导入失败: ${e.message}` }
  } finally {
    try { rmSync(staging, { recursive: true, force: true }) } catch {}
  }
}

export function listBackups() {
  if (!existsSync(BACKUP_DIR)) return []
  return readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.zip'))
    .map(f => {
      const st = statSync(join(BACKUP_DIR, f))
      return { file: f, size: st.size, mtime: st.mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
}
