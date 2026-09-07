import { useEffect, useCallback } from 'react'

type KeyCombo = string
type KeyHandler = (e: KeyboardEvent) => void

interface KeyboardShortcuts {
  [key: KeyCombo]: KeyHandler
}

/**
 * 解析键盘组合键
 * 支持格式: 'ctrl+k', 'ctrl+shift+p', 'escape'
 */
function parseKeyCombo(combo: string): {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
} {
  const parts = combo.toLowerCase().split('+')
  const key = parts[parts.length - 1]
  return {
    key,
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    meta: parts.includes('meta') || parts.includes('cmd'),
  }
}

/**
 * 检查键盘事件是否匹配组合键
 */
function matchesCombo(e: KeyboardEvent, combo: string): boolean {
  const parsed = parseKeyCombo(combo)
  const eventKey = e.key.toLowerCase()

  return (
    eventKey === parsed.key &&
    e.ctrlKey === parsed.ctrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift &&
    e.metaKey === parsed.meta
  )
}

/**
 * 快捷键 Hook
 * @param shortcuts 快捷键映射对象
 * @param enabled 是否启用
 */
export function useKeyboardShortcuts(
  shortcuts: KeyboardShortcuts,
  enabled: boolean = true
) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return

      // 如果焦点在输入框/文本域，跳过大部分快捷键
      const target = e.target as HTMLElement
      const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      const isEditable = target.isContentEditable

      for (const [combo, handler] of Object.entries(shortcuts)) {
        if (matchesCombo(e, combo)) {
          // ESC 和一些全局快捷键即使在输入框也要响应
          const isGlobalKey = combo === 'escape' || combo.startsWith('ctrl+')

          if (!isInput && !isEditable || isGlobalKey) {
            e.preventDefault()
            handler(e)
            break
          }
        }
      }
    },
    [shortcuts, enabled]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}

/**
 * 单个快捷键 Hook
 */
export function useHotkey(combo: string, handler: KeyHandler, enabled: boolean = true) {
  useKeyboardShortcuts({ [combo]: handler }, enabled)
}
