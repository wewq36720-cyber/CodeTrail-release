import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

/**
 * 国际化 Provider
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const saved = localStorage.getItem('codetrail_locale')
    if (saved && ['zh-CN', 'en-US', 'ja-JP'].includes(saved)) {
      return saved as Locale
    }
    // 检测浏览器语言
    const browserLang = navigator.language
    if (browserLang.startsWith('zh')) return 'zh-CN'
    if (browserLang.startsWith('ja')) return 'ja-JP'
    return 'en-US'
  })

  useEffect(() => {
    localStorage.setItem('codetrail_locale', locale)
    document.documentElement.lang = locale
  }, [locale])

  const t = (key: string, params?: Record<string, string | number>): string => {
    const translation = translations[locale]?.[key] || translations['zh-CN'][key] || key

    if (!params) return translation

    // 替换参数: "Hello {name}" + {name: "World"} => "Hello World"
    return translation.replace(/\{(\w+)\}/g, (_, paramKey) => {
      return params[paramKey]?.toString() || ''
    })
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

/**
 * 使用国际化 Hook
 */
export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error('useI18n must be used within I18nProvider')
  }
  return context
}

/**
 * 翻译字典
 */
const translations: Record<Locale, Record<string, string>> = {
  'zh-CN': {
    // 通用
    'app.title': 'CodeTrail 码途',
    'app.loading': '加载中...',
    'app.error': '出错了',
    'common.confirm': '确认',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.delete': '删除',
    'common.edit': '编辑',
    'common.close': '关闭',
    'common.back': '返回',
    'common.next': '下一步',
    'common.prev': '上一步',
    'common.search': '搜索',
    'common.filter': '筛选',
    'common.sort': '排序',
    'common.refresh': '刷新',
    'common.copy': '复制',
    'common.paste': '粘贴',
    'common.cut': '剪切',
    'common.undo': '撤销',
    'common.redo': '重做',

    // 导航
    'nav.dashboard': '看板',
    'nav.learning': '学习',
    'nav.settings': '设置',
    'nav.routes': '路线管理',

    // 课程
    'course.select': '选择课程',
    'course.add': '添加课程',
    'course.empty': '暂无课程',
    'course.scan': '扫描课程',
    'course.scanning': '正在扫描...',
    'course.scan.success': '扫描完成，共 {count} 门课程',
    'course.missing': '缺失 {count} 个文件',

    // 路线
    'route.name': '路线名称',
    'route.default': '默认路线',
    'route.create': '创建路线',
    'route.edit': '编辑路线',
    'route.delete': '删除路线',
    'route.import': '导入路线',
    'route.export': '导出路线',
    'route.copy': '复制路线',
    'route.empty': '暂无路线',
    'route.progress': '进度：{percent}%',

    // 步骤
    'step.title': '步骤标题',
    'step.type.file': '文件',
    'step.type.doc': '文档',
    'step.type.test': '测试',
    'step.type.checkpoint': '检查点',
    'step.status.todo': '待学习',
    'step.status.doing': '学习中',
    'step.status.done': '已完成',
    'step.status.skipped': '已跳过',
    'step.mark.done': '标记完成',
    'step.mark.skip': '跳过',
    'step.review': '开始复习',
    'step.note': '笔记',
    'step.note.save': '保存笔记',
    'step.note.saved': '笔记已保存',
    'step.rating': '自评难度',
    'step.rating.easy': '😊 简单',
    'step.rating.medium': '😐 适中',
    'step.rating.hard': '😣 困难',

    // 文件树
    'tree.search.placeholder': '搜索文件...',
    'tree.filter.all': '全部',
    'tree.filter.route': '路线文件',
    'tree.sort.name': '名称',
    'tree.sort.type': '类型',
    'tree.sort.score': '重要度',
    'tree.empty': '暂无文件',
    'tree.loading': '加载文件树...',

    // 编辑器
    'editor.empty': '请选择一个文件',
    'editor.empty.hint': '从左侧文件树选择文件，或点击学习步骤',
    'editor.tabs.limit': '最多打开 {max} 个标签页',
    'editor.close': '关闭',
    'editor.close.others': '关闭其他',
    'editor.close.all': '关闭全部',
    'editor.view.code': '代码',
    'editor.view.preview': '预览',
    'editor.bookmark.add': '添加书签',
    'editor.bookmark.list': '书签列表',

    // 验证面板
    'verify.check': '静态检查',
    'verify.test': '运行测试',
    'verify.preview': '预览',
    'verify.check.run': '执行检查',
    'verify.check.batch': '批量检查',
    'verify.test.run': '运行测试',
    'verify.test.model': '测试模型',
    'verify.test.entry': '入口文件',
    'verify.test.stdin': '标准输入',
    'verify.result.pass': '✓ 通过',
    'verify.result.fail': '✗ 失败',

    // AI 助手
    'ai.title': 'AI 助手',
    'ai.explain': '解释这段代码',
    'ai.hint': '给我一个提示',
    'ai.chat': '对话',
    'ai.chat.placeholder': '有什么问题？',
    'ai.chat.send': '发送',
    'ai.thinking': 'AI 思考中...',

    // 看板
    'dashboard.title': '学习看板',
    'dashboard.stats.courses': '课程总数',
    'dashboard.stats.steps': '步骤总数',
    'dashboard.stats.done': '已完成',
    'dashboard.section.courses': '我的课程',
    'dashboard.section.review': '复习队列',
    'dashboard.section.next': '继续学习',
    'dashboard.section.heatmap': '学习热力图',
    'dashboard.empty': '暂无数据',
    'dashboard.continue': '继续学习',

    // 设置
    'settings.title': '设置',
    'settings.tab.general': '通用',
    'settings.tab.ai': 'AI',
    'settings.tab.advanced': '高级',
    'settings.theme': '主题',
    'settings.theme.light': '浅色',
    'settings.theme.dark': '深色',
    'settings.theme.auto': '跟随系统',
    'settings.language': '语言',
    'settings.roots': '课程根目录',
    'settings.roots.add': '添加目录',
    'settings.roots.empty': '暂未添加目录',
    'settings.ai.provider': 'AI 提供商',
    'settings.ai.apikey': 'API Key',
    'settings.ai.model': '模型',
    'settings.ai.test': '测试连接',
    'settings.ai.test.success': '连接成功',
    'settings.ai.test.fail': '连接失败',
    'settings.backup': '备份数据',
    'settings.backup.export': '导出',
    'settings.backup.import': '导入',
    'settings.backup.hint': '导出学习进度、笔记等数据',

    // 通知
    'toast.saved': '已保存',
    'toast.deleted': '已删除',
    'toast.copied': '已复制',
    'toast.error': '操作失败',
    'toast.success': '操作成功',
    'toast.connection.lost': '后端服务未连接',
    'toast.connection.restored': '连接已恢复',

    // 错误
    'error.network': '网络错误',
    'error.notfound': '未找到',
    'error.unauthorized': '未授权',
    'error.server': '服务器错误',
    'error.unknown': '未知错误',
    'error.reload': '重新加载',
  },

  'en-US': {
    // Common
    'app.title': 'CodeTrail',
    'app.loading': 'Loading...',
    'app.error': 'Error',
    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.edit': 'Edit',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.next': 'Next',
    'common.prev': 'Previous',
    'common.search': 'Search',
    'common.filter': 'Filter',
    'common.sort': 'Sort',
    'common.refresh': 'Refresh',
    'common.copy': 'Copy',
    'common.paste': 'Paste',
    'common.cut': 'Cut',
    'common.undo': 'Undo',
    'common.redo': 'Redo',

    // Navigation
    'nav.dashboard': 'Dashboard',
    'nav.learning': 'Learning',
    'nav.settings': 'Settings',
    'nav.routes': 'Routes',

    // Course
    'course.select': 'Select Course',
    'course.add': 'Add Course',
    'course.empty': 'No courses',
    'course.scan': 'Scan Courses',
    'course.scanning': 'Scanning...',
    'course.scan.success': 'Scanned {count} courses',
    'course.missing': '{count} files missing',

    // Route
    'route.name': 'Route Name',
    'route.default': 'Default',
    'route.create': 'Create Route',
    'route.edit': 'Edit Route',
    'route.delete': 'Delete Route',
    'route.import': 'Import',
    'route.export': 'Export',
    'route.copy': 'Copy',
    'route.empty': 'No routes',
    'route.progress': 'Progress: {percent}%',

    // Step
    'step.title': 'Step Title',
    'step.type.file': 'File',
    'step.type.doc': 'Document',
    'step.type.test': 'Test',
    'step.type.checkpoint': 'Checkpoint',
    'step.status.todo': 'Todo',
    'step.status.doing': 'In Progress',
    'step.status.done': 'Done',
    'step.status.skipped': 'Skipped',
    'step.mark.done': 'Mark as Done',
    'step.mark.skip': 'Skip',
    'step.review': 'Start Review',
    'step.note': 'Note',
    'step.note.save': 'Save Note',
    'step.note.saved': 'Note saved',
    'step.rating': 'Difficulty Rating',
    'step.rating.easy': '😊 Easy',
    'step.rating.medium': '😐 Medium',
    'step.rating.hard': '😣 Hard',

    // File Tree
    'tree.search.placeholder': 'Search files...',
    'tree.filter.all': 'All',
    'tree.filter.route': 'Route files',
    'tree.sort.name': 'Name',
    'tree.sort.type': 'Type',
    'tree.sort.score': 'Importance',
    'tree.empty': 'No files',
    'tree.loading': 'Loading file tree...',

    // Editor
    'editor.empty': 'Select a file',
    'editor.empty.hint': 'Choose a file from the tree or click a learning step',
    'editor.tabs.limit': 'Max {max} tabs',
    'editor.close': 'Close',
    'editor.close.others': 'Close Others',
    'editor.close.all': 'Close All',
    'editor.view.code': 'Code',
    'editor.view.preview': 'Preview',
    'editor.bookmark.add': 'Add Bookmark',
    'editor.bookmark.list': 'Bookmarks',

    // Verify
    'verify.check': 'Static Check',
    'verify.test': 'Run Test',
    'verify.preview': 'Preview',
    'verify.check.run': 'Run Check',
    'verify.check.batch': 'Batch Check',
    'verify.test.run': 'Run Test',
    'verify.test.model': 'Test Model',
    'verify.test.entry': 'Entry File',
    'verify.test.stdin': 'Stdin',
    'verify.result.pass': '✓ Pass',
    'verify.result.fail': '✗ Fail',

    // AI
    'ai.title': 'AI Assistant',
    'ai.explain': 'Explain this code',
    'ai.hint': 'Give me a hint',
    'ai.chat': 'Chat',
    'ai.chat.placeholder': 'Ask anything...',
    'ai.chat.send': 'Send',
    'ai.thinking': 'AI thinking...',

    // Dashboard
    'dashboard.title': 'Dashboard',
    'dashboard.stats.courses': 'Courses',
    'dashboard.stats.steps': 'Steps',
    'dashboard.stats.done': 'Done',
    'dashboard.section.courses': 'My Courses',
    'dashboard.section.review': 'Review Queue',
    'dashboard.section.next': 'Continue Learning',
    'dashboard.section.heatmap': 'Activity Heatmap',
    'dashboard.empty': 'No data',
    'dashboard.continue': 'Continue',

    // Settings
    'settings.title': 'Settings',
    'settings.tab.general': 'General',
    'settings.tab.ai': 'AI',
    'settings.tab.advanced': 'Advanced',
    'settings.theme': 'Theme',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.theme.auto': 'Auto',
    'settings.language': 'Language',
    'settings.roots': 'Course Directories',
    'settings.roots.add': 'Add Directory',
    'settings.roots.empty': 'No directories',
    'settings.ai.provider': 'AI Provider',
    'settings.ai.apikey': 'API Key',
    'settings.ai.model': 'Model',
    'settings.ai.test': 'Test Connection',
    'settings.ai.test.success': 'Connected',
    'settings.ai.test.fail': 'Failed',
    'settings.backup': 'Backup Data',
    'settings.backup.export': 'Export',
    'settings.backup.import': 'Import',
    'settings.backup.hint': 'Export progress, notes and data',

    // Toast
    'toast.saved': 'Saved',
    'toast.deleted': 'Deleted',
    'toast.copied': 'Copied',
    'toast.error': 'Error',
    'toast.success': 'Success',
    'toast.connection.lost': 'Connection lost',
    'toast.connection.restored': 'Connection restored',

    // Error
    'error.network': 'Network error',
    'error.notfound': 'Not found',
    'error.unauthorized': 'Unauthorized',
    'error.server': 'Server error',
    'error.unknown': 'Unknown error',
    'error.reload': 'Reload',
  },

  'ja-JP': {
    // 共通
    'app.title': 'CodeTrail',
    'app.loading': '読み込み中...',
    'app.error': 'エラー',
    'common.confirm': '確認',
    'common.cancel': 'キャンセル',
    'common.save': '保存',
    'common.delete': '削除',
    'common.edit': '編集',
    'common.close': '閉じる',
    'common.back': '戻る',
    'common.next': '次へ',
    'common.prev': '前へ',
    'common.search': '検索',
    'common.filter': 'フィルター',
    'common.sort': '並び替え',
    'common.refresh': '更新',
    'common.copy': 'コピー',
    'common.paste': '貼り付け',
    'common.cut': '切り取り',
    'common.undo': '元に戻す',
    'common.redo': 'やり直す',

    // ナビゲーション
    'nav.dashboard': 'ダッシュボード',
    'nav.learning': '学習',
    'nav.settings': '設定',
    'nav.routes': 'ルート管理',

    // コース
    'course.select': 'コースを選択',
    'course.add': 'コースを追加',
    'course.empty': 'コースがありません',
    'course.scan': 'スキャン',
    'course.scanning': 'スキャン中...',
    'course.scan.success': '{count}件のコースをスキャンしました',
    'course.missing': '{count}個のファイルが見つかりません',

    // ルート
    'route.name': 'ルート名',
    'route.default': 'デフォルト',
    'route.create': 'ルートを作成',
    'route.edit': 'ルートを編集',
    'route.delete': 'ルートを削除',
    'route.import': 'インポート',
    'route.export': 'エクスポート',
    'route.copy': 'コピー',
    'route.empty': 'ルートがありません',
    'route.progress': '進捗: {percent}%',

    // ステップ
    'step.title': 'ステップタイトル',
    'step.type.file': 'ファイル',
    'step.type.doc': 'ドキュメント',
    'step.type.test': 'テスト',
    'step.type.checkpoint': 'チェックポイント',
    'step.status.todo': '未学習',
    'step.status.doing': '学習中',
    'step.status.done': '完了',
    'step.status.skipped': 'スキップ',
    'step.mark.done': '完了にする',
    'step.mark.skip': 'スキップ',
    'step.review': '復習を開始',
    'step.note': 'メモ',
    'step.note.save': 'メモを保存',
    'step.note.saved': 'メモが保存されました',
    'step.rating': '難易度評価',
    'step.rating.easy': '😊 簡単',
    'step.rating.medium': '😐 普通',
    'step.rating.hard': '😣 難しい',

    // ファイルツリー
    'tree.search.placeholder': 'ファイルを検索...',
    'tree.filter.all': 'すべて',
    'tree.filter.route': 'ルートファイル',
    'tree.sort.name': '名前',
    'tree.sort.type': 'タイプ',
    'tree.sort.score': '重要度',
    'tree.empty': 'ファイルがありません',
    'tree.loading': 'ファイルツリーを読み込み中...',

    // エディター
    'editor.empty': 'ファイルを選択してください',
    'editor.empty.hint': 'ファイルツリーからファイルを選択するか、学習ステップをクリックしてください',
    'editor.tabs.limit': '最大{max}個のタブ',
    'editor.close': '閉じる',
    'editor.close.others': '他を閉じる',
    'editor.close.all': 'すべて閉じる',
    'editor.view.code': 'コード',
    'editor.view.preview': 'プレビュー',
    'editor.bookmark.add': 'ブックマークを追加',
    'editor.bookmark.list': 'ブックマーク一覧',

    // 検証
    'verify.check': '静的チェック',
    'verify.test': 'テスト実行',
    'verify.preview': 'プレビュー',
    'verify.check.run': 'チェック実行',
    'verify.check.batch': '一括チェック',
    'verify.test.run': 'テスト実行',
    'verify.test.model': 'テストモデル',
    'verify.test.entry': 'エントリーファイル',
    'verify.test.stdin': '標準入力',
    'verify.result.pass': '✓ 合格',
    'verify.result.fail': '✗ 不合格',

    // AI
    'ai.title': 'AIアシスタント',
    'ai.explain': 'このコードを説明',
    'ai.hint': 'ヒントをください',
    'ai.chat': 'チャット',
    'ai.chat.placeholder': '質問を入力...',
    'ai.chat.send': '送信',
    'ai.thinking': 'AI が考え中...',

    // ダッシュボード
    'dashboard.title': '学習ダッシュボード',
    'dashboard.stats.courses': 'コース数',
    'dashboard.stats.steps': 'ステップ数',
    'dashboard.stats.done': '完了数',
    'dashboard.section.courses': 'マイコース',
    'dashboard.section.review': '復習キュー',
    'dashboard.section.next': '学習を続ける',
    'dashboard.section.heatmap': '学習ヒートマップ',
    'dashboard.empty': 'データがありません',
    'dashboard.continue': '続ける',

    // 設定
    'settings.title': '設定',
    'settings.tab.general': '一般',
    'settings.tab.ai': 'AI',
    'settings.tab.advanced': '詳細',
    'settings.theme': 'テーマ',
    'settings.theme.light': 'ライト',
    'settings.theme.dark': 'ダーク',
    'settings.theme.auto': '自動',
    'settings.language': '言語',
    'settings.roots': 'コースディレクトリ',
    'settings.roots.add': 'ディレクトリを追加',
    'settings.roots.empty': 'ディレクトリがありません',
    'settings.ai.provider': 'AIプロバイダー',
    'settings.ai.apikey': 'APIキー',
    'settings.ai.model': 'モデル',
    'settings.ai.test': '接続テスト',
    'settings.ai.test.success': '接続成功',
    'settings.ai.test.fail': '接続失敗',
    'settings.backup': 'データバックアップ',
    'settings.backup.export': 'エクスポート',
    'settings.backup.import': 'インポート',
    'settings.backup.hint': '学習進捗とメモをエクスポート',

    // トースト
    'toast.saved': '保存しました',
    'toast.deleted': '削除しました',
    'toast.copied': 'コピーしました',
    'toast.error': 'エラーが発生しました',
    'toast.success': '成功しました',
    'toast.connection.lost': '接続が切れました',
    'toast.connection.restored': '接続が復旧しました',

    // エラー
    'error.network': 'ネットワークエラー',
    'error.notfound': '見つかりません',
    'error.unauthorized': '認証エラー',
    'error.server': 'サーバーエラー',
    'error.unknown': '不明なエラー',
    'error.reload': '再読み込み',
  },
}
