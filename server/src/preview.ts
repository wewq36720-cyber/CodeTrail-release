import { getLddPath } from './db/index.js'
import { getCourseById } from './scanner.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync, statSync, readdirSync } from 'fs'
import { join, resolve, extname } from 'path'
import { randomUUID } from 'crypto'

const LDD = getLddPath()
const PREVIEW_DIR = join(LDD, 'preview')
mkdirSync(PREVIEW_DIR, { recursive: true })

const TTL_MS = 5 * 60 * 1000
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
}

interface PreviewEntry { dir: string; timer: NodeJS.Timeout }
const activePreviews = new Map<string, PreviewEntry>()

function touchExpiry(token: string, entry: PreviewEntry) {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => cleanupPreview(token), TTL_MS)
}

// FR-19：md 渲染 / html 或静态目录 → LDD 内复制副本 + 随机 token 服务，5 分钟无访问自动清理
export function getPreviewToken(body: { courseId: string; path: string }): { token: string; url: string; kind: string } {
  const course = getCourseById(body.courseId)
  if (!course) throw new Error('Course not found')

  const srcPath = resolve(course.root, body.path)
  if (!srcPath.toLowerCase().startsWith(resolve(course.root).toLowerCase())) throw new Error('Path traversal denied')
  if (!existsSync(srcPath)) throw new Error('文件不存在')

  const token = randomUUID()
  const previewPath = join(PREVIEW_DIR, token)
  mkdirSync(previewPath, { recursive: true })

  let kind = 'static'
  const st = statSync(srcPath)
  const ext = extname(srcPath).toLowerCase()

  if (st.isDirectory()) {
    cpSync(srcPath, previewPath, { recursive: true })
  } else if (ext === '.md') {
    writeFileSync(join(previewPath, 'index.html'), wrapHtml(renderMarkdown(readFileSync(srcPath, 'utf8'))))
    kind = 'md'
  } else if (['.html', '.htm'].includes(ext)) {
    cpSync(srcPath, join(previewPath, 'index.html'))
  } else {
    cpSync(srcPath, join(previewPath, srcPath.split(/[\\/]/).pop()!))
    kind = 'file'
  }

  const entry: PreviewEntry = { dir: previewPath, timer: null as any }
  touchExpiry(token, entry)
  activePreviews.set(token, entry)
  return { token, url: `/api/preview/${token}`, kind }
}

export function servePreview(token: string, res: any) {
  const entry = activePreviews.get(token)
  if (!entry) {
    res.status(404).send('预览不存在或已过期（5 分钟无访问自动关闭）')
    return
  }
  touchExpiry(token, entry)

  const rel = (res.req?.url as string || '').replace(`/api/preview/${token}`, '').replace(/^\//, '')
  let filePath = join(entry.dir, decodeURIComponent(rel || 'index.html'))
  if (!filePath.toLowerCase().startsWith(entry.dir.toLowerCase())) {
    res.status(403).send('Forbidden')
    return
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html')
    if (!existsSync(filePath)) {
      // 单文件目录兜底
      const files = readdirSync(entry.dir)
      const single = files.find(f => f.endsWith('.html'))
      if (single) filePath = join(entry.dir, single)
      else { res.status(404).send('No index.html found'); return }
    }
  }

  const ext = extname(filePath).toLowerCase()
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
  res.send(readFileSync(filePath))
}

function cleanupPreview(token: string) {
  const entry = activePreviews.get(token)
  if (entry) {
    clearTimeout(entry.timer)
    try { rmSync(entry.dir, { recursive: true, force: true }) } catch {}
    activePreviews.delete(token)
  }
}

// --- 极简 markdown 渲染（预览通道专用；文档课程主视图由前端 react-markdown 渲染） ---
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderMarkdown(md: string): string {
  const blocks: string[] = []
  let text = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    blocks.push(`<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`)
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })

  text = escapeHtml(text)
  text = text
    .replace(/^###### (.*)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^&gt; (.*)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/^\|(.+)\|$/gm, (m) => m) // 表格保持原样（简单场景够用）
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>')

  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)])
  return text
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CodeTrail 预览</title>
<style>body{font-family:system-ui,'Microsoft YaHei',sans-serif;padding:2rem;max-width:900px;margin:auto;line-height:1.7;color:#222}
h1,h2,h3{color:#111}pre{background:#1e1e2e;color:#cdd6f4;padding:1rem;overflow:auto;border-radius:8px}
code{font-family:Consolas,monospace;background:#f2f2f5;padding:.1em .3em;border-radius:4px}
pre code{background:none}blockquote{border-left:3px solid #ccc;margin:0;padding-left:1rem;color:#555}
table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:.3rem .6rem}</style>
</head><body>${body}</body></html>`
}
