import { existsSync } from 'fs'

// 容器/挂载环境路径映射：LEARNDESK_PATH_MAP="D:\Study=/workspace"（多组用 ; 分隔）。
// UI 里用户习惯填 Windows 路径，容器内不存在时按前缀映射到挂载点，避免「加了根路径却扫不到课程」。
function mapPairs(): Array<{ from: string; to: string }> {
  const raw = process.env.LEARNDESK_PATH_MAP || ''
  const out: Array<{ from: string; to: string }> = []
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const from = pair.slice(0, i).trim().replace(/\\/g, '/').replace(/\/+$/, '')
    const to = pair.slice(i + 1).trim().replace(/\/+$/, '')
    if (from && to) out.push({ from, to })
  }
  return out
}

export function mapPath(p: string): string {
  if (!p) return p
  const norm = p.replace(/\\/g, '/')
  const lower = norm.toLowerCase()
  for (const { from, to } of mapPairs()) {
    const fl = from.toLowerCase()
    if (lower === fl || lower.startsWith(fl + '/')) {
      const mapped = to + norm.slice(from.length)
      if (existsSync(mapped)) return mapped
    }
  }
  return p
}

// 原路径存在则原样返回；否则尝试映射；仍不存在返回原值（让调用方按缺失处理）
export function resolveFsPath(p: string): string {
  if (!p) return p
  if (existsSync(p)) return p
  const mapped = mapPath(p)
  return existsSync(mapped) ? mapped : p
}
