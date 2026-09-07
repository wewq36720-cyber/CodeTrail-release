import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/* ============================================================
   五主题机制（DESIGN.md v3.2）
   html[data-theme] = 唯一开关；localStorage['ct-theme'] 持久化。
   ============================================================ */

export type ThemeId = 'cream' | 'matcha' | 'ink' | 'board' | 'slate'

export const THEME_KEY = 'ct-theme'

/** 主题元数据：色板展示用（与 styles/themes.css 的令牌值同源，改令牌需同步这里） */
export const THEMES: Array<{ id: ThemeId; name: string; note: string; bg: string; accent: string }> = [
  { id: 'cream',  name: '奶油 · 深绿', note: '默认 · 源自《主界面.png》', bg: '#F2EEE1', accent: '#2F5D46' },
  { id: 'matcha', name: '浅绿纸 · 墨绿', note: '源自《文件树》统一稿',     bg: '#EDF4E7', accent: '#2F7D3F' },
  { id: 'ink',    name: '墨夜 · 亮绿',   note: '全站暗色模式',             bg: '#141612', accent: '#5FCB73' },
  { id: 'board',  name: '燕麦 · 榜单绿', note: '源自《学习项目看板》',     bg: '#F2EEDF', accent: '#3F9A55' },
  { id: 'slate',  name: '白纸 · 蓝调',   note: '源自《学习项目一览》',     bg: '#F7F8FA', accent: '#2F6FDE' },
]

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some(t => t.id === v)
}

export function readStoredTheme(): ThemeId {
  try {
    // URL 参数优先（预览 / 验收 / 分享链接用）
    const q = new URLSearchParams(location.search).get('theme')
    if (isThemeId(q)) {
      localStorage.setItem(THEME_KEY, q)
      return q
    }
    const v = localStorage.getItem(THEME_KEY)
    if (isThemeId(v)) return v
  } catch { /* 隐私模式等 */ }
  return 'cream'
}

/** 尽早调用（main.tsx 顶部）：避免首帧闪烁 */
export function applyThemeToDom(id: ThemeId) {
  document.documentElement.dataset.theme = id
}

interface ThemeCtx {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
}

const Ctx = createContext<ThemeCtx>({ theme: 'cream', setTheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(readStoredTheme)

  useEffect(() => {
    applyThemeToDom(theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* noop */ }
  }, [theme])

  // 多标签页同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY && isThemeId(e.newValue)) setThemeState(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((id: ThemeId) => setThemeState(id), [])

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme() {
  return useContext(Ctx)
}

/** 读取当前主题下某令牌的计算值（Monaco 定制等场景） */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
