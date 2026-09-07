import { useEffect, useState } from 'react'

/**
 * 防抖 Hook - 延迟更新值直到停止变化
 * @param value 要防抖的值
 * @param delay 延迟时间（毫秒）
 */
export function useDebounce<T>(value: T, delay: number = 500): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => clearTimeout(timer)
  }, [value, delay])

  return debouncedValue
}

/**
 * 防抖回调 Hook - 返回防抖后的函数
 */
export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number = 500
): (...args: Parameters<T>) => void {
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | null>(null)

  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    setTimer(setTimeout(() => callback(...args), delay))
  }
}
