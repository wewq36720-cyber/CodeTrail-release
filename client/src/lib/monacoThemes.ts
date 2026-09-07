import type { ThemeId } from '../theme/ThemeContext'

/* ============================================================
   Monaco 五主题（DESIGN.md §3：浅系四主题共用 light 基底，ink 用暗基底）
   色值与 styles/themes.css 的 --code-* / --ink / --accent 令牌同源，改令牌需同步。
   ============================================================ */

interface MonacoPalette {
  bg: string; fg: string; ln: string; hl: string
  kw: string; ty: string; fn: string; st: string; cm: string; nu: string
  accent: string; sel: string
}

const PALETTES: Record<ThemeId, MonacoPalette> = {
  cream:  { bg: '#FBF9F0', fg: '#26302A', ln: '#B9BFA9', hl: '#EFF3DF', kw: '#2F6B46', ty: '#3E6E9E', fn: '#7A4E9E', st: '#A96A2B', cm: '#9AA48E', nu: '#B5543C', accent: '#2F5D46', sel: '#E3EBDB' },
  matcha: { bg: '#F6FBF2', fg: '#1F3A24', ln: '#A9BBA1', hl: '#E4F0DB', kw: '#2F6B46', ty: '#3B77D9', fn: '#7C5CC4', st: '#A96A2B', cm: '#8AA383', nu: '#D9483B', accent: '#2F7D3F', sel: '#D8E7CF' },
  ink:    { bg: '#10120E', fg: '#E9EDE4', ln: '#4A5245', hl: '#1D2518', kw: '#7BD88F', ty: '#6FB7E8', fn: '#C9A6F0', st: '#E0B96A', cm: '#5F6B5A', nu: '#E05A4E', accent: '#5FCB73', sel: '#1E2A1D' },
  board:  { bg: '#FBF8EC', fg: '#1D211A', ln: '#B9B49A', hl: '#EEF3DC', kw: '#2F6B46', ty: '#2B6BA8', fn: '#7C5CC4', st: '#A96A2B', cm: '#A0A086', nu: '#BC5440', accent: '#3F9A55', sel: '#DDEED9' },
  slate:  { bg: '#FFFFFF', fg: '#1F2430', ln: '#C0C6D0', hl: '#EFF4FE', kw: '#2F6FDE', ty: '#2E9E5B', fn: '#7C5CC4', st: '#C9862B', cm: '#8A93A3', nu: '#D9483B', accent: '#2F6FDE', sel: '#EEF4FE' },
}

export function monacoThemeName(id: ThemeId): string {
  return `ct-${id}`
}

/** 在 monaco 实例就绪时定义全部五套主题（幂等，可重复调用） */
export function defineMonacoThemes(monaco: any) {
  ;(Object.keys(PALETTES) as ThemeId[]).forEach(id => {
    const c = PALETTES[id]
    monaco.editor.defineTheme(monacoThemeName(id), {
      base: id === 'ink' ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: c.kw.slice(1), fontStyle: 'bold' },
        { token: 'type', foreground: c.ty.slice(1) },
        { token: 'function', foreground: c.fn.slice(1) },
        { token: 'string', foreground: c.st.slice(1) },
        { token: 'number', foreground: c.nu.slice(1) },
        { token: 'comment', foreground: c.cm.slice(1), fontStyle: 'italic' },
        { token: 'delimiter', foreground: c.fg.slice(1) }
      ],
      colors: {
        'editor.background': c.bg,
        'editor.foreground': c.fg,
        'editorLineNumber.foreground': c.ln,
        'editorLineNumber.activeForeground': c.fg,
        'editor.selectionBackground': c.sel,
        'editor.lineHighlightBackground': c.hl,
        'editorCursor.foreground': c.accent,
        'editorIndentGuide.background': c.ln + '55',
        'editorIndentGuide.activeBackground': c.ln,
        'editorWhitespace.foreground': c.ln + '77',
        'scrollbarSlider.background': c.ln + '44',
        'scrollbarSlider.hoverBackground': c.ln + '66'
      }
    })
  })
}
