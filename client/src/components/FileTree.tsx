import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { Course, Route, StepProgress, FileNode } from '../types'

interface FileTreeProps {
  course: Course | undefined
  route: Route | undefined
  progress: Record<string, StepProgress>
  onFileClick: (file: string) => void
}

interface CoreFile { path: string; score: number; lines: number; symbols?: any[]; importedBy?: number; role?: string }

/* 分支语义（filetree 稿）：核心橙 / 示例绿 / 内部蓝 / 测试红 / 文档紫 / 配置琥珀 */
function dirBranch(name: string, role?: string): string {
  if (role === 'core' || /^(pkg|src|lib|cmd)$/i.test(name)) return 'var(--br-org)'
  if (role === 'example' || /^examples?$/i.test(name)) return 'var(--br-grn)'
  if (/^(internal|private)$/i.test(name)) return 'var(--br-blu)'
  if (role === 'test' || /tests?|spec|validation/i.test(name)) return 'var(--br-red)'
  if (role === 'doc' || /^(docs?|\.github|assets)$/i.test(name)) return 'var(--br-pur)'
  return 'var(--br-amb)'
}

const ROLE_LABEL: Record<string, string> = {
  core: '核心', entry: '入口', example: '示例', test: '测试', doc: '文档', config: '配置'
}

const STATUS_WORD: Record<string, string> = { done: '已完成', doing: '进行中', skipped: '已跳过' }

/* 懒加载树（展开才拉该层）+ 三列秩序：连线列 → 名称列 → 注释列 */
export function FileTree({ course, route, progress, onFileClick }: FileTreeProps) {
  const [dirs, setDirs] = useState<Map<string, FileNode[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<'name' | 'size' | 'mtime'>('name')
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Array<{ path: string; name: string; type: 'file' | 'directory' }> | null>(null)
  const [searching, setSearching] = useState(false)
  const [loadingDir, setLoadingDir] = useState<string | null>(null)
  const [coreFiles, setCoreFiles] = useState<CoreFile[]>([])
  const [coreOpen, setCoreOpen] = useState(true)
  const [indexStale, setIndexStale] = useState(false)
  const [rootCount, setRootCount] = useState<number | null>(null)
  const [selectedPath, setSelectedPath] = useState<string>('')
  const searchTimer = useRef<number | null>(null)

  // 路线收录的目录链（分支高亮判定）
  const routeDirs = useMemo(() => {
    const set = new Set<string>()
    for (const s of route?.steps || []) {
      if (!s.file) continue
      const segs = s.file.split('/')
      for (let i = 1; i < segs.length; i++) set.add(segs.slice(0, i).join('/'))
    }
    return set
  }, [route])

  useEffect(() => {
    if (!course) return
    setDirs(new Map())
    setExpanded(new Set())
    setSearch('')
    setSearchResults(null)
    setSelectedPath('')
    setRootCount(null)
    loadDir('')
    api.getIndexSummary(course.id).then(s => {
      if (s && s.topCore) { setCoreFiles(s.topCore); setIndexStale(!!s.stale) }
      else setCoreFiles([])
    }).catch(() => setCoreFiles([]))
  }, [course?.id])

  const loadDir = useCallback(async (dir: string) => {
    if (!course) return
    setLoadingDir(dir)
    try {
      const res = await api.getDirectory(course.id, dir, sort)
      setDirs(prev => new Map(prev).set(dir, res.nodes))
      if (dir === '' && typeof res.fileCount === 'number') setRootCount(res.fileCount)
    } catch {
      setDirs(prev => new Map(prev).set(dir, []))
    } finally {
      setLoadingDir(null)
    }
  }, [course?.id, sort])

  // 排序变化：已加载的层重新请求
  useEffect(() => {
    if (!course || dirs.size === 0) return
    for (const dir of dirs.keys()) loadDir(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort])

  // 搜索防抖 → 服务端深搜
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    if (!course) return
    if (!search.trim()) { setSearchResults(null); setSearching(false); return }
    setSearching(true)
    searchTimer.current = window.setTimeout(async () => {
      try {
        setSearchResults(await api.searchCourseFiles(course.id, search.trim()))
      } catch { setSearchResults([]) }
      setSearching(false)
    }, 300)
  }, [search, course?.id])

  function toggleExpand(node: FileNode) {
    const p = node.path
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else {
        next.add(p)
        if (!dirs.has(p)) loadDir(p)
      }
      return next
    })
  }

  /* 注释列：一切元信息（说明 · 重要度 · 步骤状态）统一收进 # 注释 */
  function commentOf(node: FileNode): { text: string; cls: string } | null {
    const step = route?.steps.find(s => s.file === node.path)
    if (step) {
      const st = progress[step.id]?.status
      const word = st && st !== 'todo' ? ` · ${STATUS_WORD[st] || st}` : ' · 下一步'
      const cls = st === 'done' ? 'k' : step.type === 'test' ? 'warn' : ''
      return { text: `# ${step.title}${word}`, cls }
    }
    const role = (node as any).role as string | undefined
    const score = (node as any).score as number | undefined
    if (role && ROLE_LABEL[role]) {
      return { text: `# ${ROLE_LABEL[role]}${role === 'core' && typeof score === 'number' ? ` · 重要度 ${score}` : ''}`, cls: role === 'core' ? 'k' : '' }
    }
    return null
  }

  function renderNode(node: FileNode, guidePrefix: string, isLast: boolean): React.ReactElement | null {
    const guide = guidePrefix + (isLast ? '└── ' : '├── ')
    const childPrefix = guidePrefix + (isLast ? '\u00a0\u00a0\u00a0' : '│\u00a0\u00a0')
    const com = commentOf(node)

    if (node.type === 'directory') {
      const isOpen = expanded.has(node.path)
      const children = dirs.get(node.path)
      const onRoute = routeDirs.has(node.path)
      const color = onRoute || !route ? dirBranch(node.name, (node as any).role) : 'var(--com)'
      return (
        <div key={node.path}>
          <div className="trow" onClick={() => toggleExpand(node)} title={node.path + '/'}>
            <span className="tname">
              <span className="g">{guide}</span>
              <span className="dir" style={{ color }}>{isOpen ? '▾' : '▸'} {node.name}/</span>
            </span>
            {com && <span className={`com ${com.cls}`}>{com.text}</span>}
          </div>
          {isOpen && (
            <div>
              {loadingDir === node.path && children === undefined
                ? <div className="tree-loading" style={{ paddingLeft: 12 }}>{childPrefix.replace(/\u00a0/g, ' ')}加载中…</div>
                : (children || []).map((c, i, arr) => renderNode(c, childPrefix, i === arr.length - 1))}
            </div>
          )}
        </div>
      )
    }

    const step = route?.steps.find(s => s.file === node.path)
    const st = step ? progress[step.id]?.status : undefined
    const stGlyph = step ? (st === 'done' ? '✓' : st === 'doing' ? '▸' : st === 'skipped' ? '⊘' : '○') : null
    const stCls = st === 'done' ? 'done' : st === 'doing' ? 'doing' : st === 'skipped' ? 'skipped' : 'todo'

    return (
      <div
        key={node.path}
        className={`trow ${selectedPath === node.path ? 'sel' : ''}`}
        title={node.path}
        onClick={() => { setSelectedPath(node.path); onFileClick(node.path) }}
      >
        <span className="tname">
          <span className="g">{guide}</span>
          {stGlyph && <span className={`st ${stCls}`}>{stGlyph}</span>}
          <span className="fnm">{node.name}</span>
        </span>
        {com && <span className={`com ${com.cls}`}>{com.text}</span>}
      </div>
    )
  }

  if (!course) return <div className="file-tree-empty">选择课程查看文件树</div>

  const rootNodes = dirs.get('') || []

  return (
    <div className="file-tree">
      <div className="ft-head">
        <span className="root-chip"><span className="name">{course.slug}</span><span className="lang">{(course.lang || '').toUpperCase()}</span></span>
        <span className="ft-cnt">{rootCount !== null ? `${rootCount} files` : '懒加载'}</span>
      </div>

      <div className="ft-searchrow">
        <div className="tree-search">
          <span>//</span>
          <input
            type="text"
            placeholder="搜索文件（全库深搜，300ms 防抖）"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="ft-sort" value={sort} onChange={e => setSort(e.target.value as any)} title="排序方式">
          <option value="name">名称</option>
          <option value="size">大小</option>
          <option value="mtime">时间</option>
        </select>
      </div>

      {coreFiles.length > 0 && !search && (
        <div className="core-section">
          <div className="core-lab" onClick={() => setCoreOpen(v => !v)}>
            <span># code-index · PageRank Top{coreFiles.length}{indexStale ? '（索引已过期）' : ''}</span>
            <span className="chev">{coreOpen ? '▾' : '▸'}</span>
          </div>
          {coreOpen && (
            <>
              {indexStale && <div className="core-stale">⚠ 仓库有更新，重建索引见「路线管理」</div>}
              {coreFiles.map(f => (
                <div key={f.path} className="core" onClick={() => { setSelectedPath(f.path); onFileClick(f.path) }} title={`${f.path}\n重要度 ${f.score}/100 · 约 ${Math.max(1, Math.round((f.lines || 0) / 250))} 分钟`}>
                  <span className="nm">{f.path.split('/').pop()}</span>
                  <span className="bar"><i style={{ width: `${f.score}%` }} /></span>
                  <span className="sc">{f.score}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="tree">
        {search || searching ? (
          searching && !searchResults
            ? <div className="tree-loading">搜索中…</div>
            : (searchResults?.length || 0) === 0
              ? <div className="tree-empty">无匹配文件</div>
              : (
                <div className="search-results">
                  {searchResults!.map(r => (
                    <div
                      key={r.path}
                      className="srow"
                      onClick={() => { if (r.type === 'file') { setSelectedPath(r.path); onFileClick(r.path) } }}
                      title={r.path}
                    >
                      <span className="sname">{r.type === 'directory' ? `${r.name}/` : r.name}</span>
                      <span className="search-path">{r.path}</span>
                    </div>
                  ))}
                </div>
              )
        ) : loadingDir === '' && !dirs.has('')
          ? <div className="tree-loading">加载中…</div>
          : rootNodes.length === 0
            ? <div className="tree-empty">{course.missing ? '⚠ 课程目录缺失' : '无文件'}</div>
            : rootNodes.map((n, i, arr) => renderNode(n, '', i === arr.length - 1))}
      </div>
    </div>
  )
}
