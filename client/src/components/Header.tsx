import { useState } from 'react'
import type { Course } from '../types'

export type AppView = 'main' | 'dashboard' | 'ai'

interface HeaderProps {
  view: AppView
  setView: (v: AppView) => void
  courses: Course[]
  selectedCourseId: string
  routeCount: number
  onCourseChange: (id: string) => void
  onSettingsClick: () => void
  onRoutesClick: () => void
  onCheckClick: () => void
  onPreviewClick: () => void
}

/* 顶栏（main 稿）：品牌 × 课程胶囊 × 中央分段导航 × 动作 pill */
export function Header({ view, setView, courses, selectedCourseId, routeCount, onCourseChange, onSettingsClick, onRoutesClick, onCheckClick, onPreviewClick }: HeaderProps) {
  const [showCourseMenu, setShowCourseMenu] = useState(false)
  const selectedCourse = courses.find(c => c.id === selectedCourseId)

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">◈</div>
        <div>
          <div className="brand-name">CodeTrail 码途</div>
          <div className="brand-sub">CODE TRAIL</div>
        </div>
      </div>

      <div className="course-selector-wrap">
        <div className="course-pill" onClick={() => setShowCourseMenu(v => !v)} title="切换课程">
          <span>{selectedCourse?.kind === 'repo' ? '📦' : '📄'}</span>
          <b>{selectedCourse?.slug || '选择课程'}</b>
          <small>{selectedCourse ? `${selectedCourse.lang}${routeCount > 0 ? ` · ${routeCount} 条路线` : ''}` : '扫描根路径后自动出现课程'}</small>
          {selectedCourse && Number(selectedCourse.missing) === 1 && <span className="course-missing">⚠ 缺失</span>}
          <span className="chev">▼</span>
        </div>
        {showCourseMenu && (
          <>
            <div className="menu-overlay" onClick={() => setShowCourseMenu(false)} />
            <div className="course-dropdown" onClick={e => e.stopPropagation()}>
              {courses.map(c => (
                <button
                  key={c.id}
                  className={`course-item ${c.id === selectedCourseId ? 'active' : ''}`}
                  onClick={() => { onCourseChange(c.id); setShowCourseMenu(false) }}
                >
                  <span className="course-type">{c.kind === 'repo' ? '📦' : '📄'}</span>
                  <span className="course-title">{c.slug}</span>
                  <span className="course-lang">{c.lang}</span>
                  {Number(c.missing) === 1 && <span className="course-missing">⚠</span>}
                </button>
              ))}
              <hr />
              <button className="course-item add-root" onClick={() => { setShowCourseMenu(false); onSettingsClick() }}>
                ＋ 添加根路径 / 重新扫描
              </button>
            </div>
          </>
        )}
      </div>

      <nav className="seg">
        <button className={view === 'main' ? 'active' : ''} onClick={() => setView('main')} title="项目一览 · 路线图 · 任务">工作台</button>
        <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>看板</button>
        <button className={view === 'ai' ? 'active' : ''} onClick={() => setView('ai')} title="学习界面：查阅 · 对话 · 测试 · 标记完成">AI 助手</button>
        <button onClick={onRoutesClick} title="路线管理">路线</button>
      </nav>

      <div className="top-actions">
        <button className="pill" onClick={onCheckClick} title="静态检查当前文件">✓ 静态检查</button>
        <button className="pill" onClick={onPreviewClick} title="预览当前文件">👁 预览</button>
        <button className="pill solid" onClick={onSettingsClick} title="设置">⚙ 设置</button>
      </div>
    </header>
  )
}
