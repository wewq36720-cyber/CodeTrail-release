/**
 * 条件类名组合工具 - 简化版 clsx
 */
type ClassValue = string | number | boolean | undefined | null | ClassValue[]

export function cn(...classes: ClassValue[]): string {
  return classes
    .flat()
    .filter((cls) => typeof cls === 'string' && cls.length > 0)
    .join(' ')
}

/**
 * 使用示例:
 * cn('btn', isActive && 'active', isPrimary && 'btn-primary')
 * cn(['btn', 'btn-lg'], { 'btn-disabled': disabled })
 */
