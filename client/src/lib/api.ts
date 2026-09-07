import type { RouteTemplate, RouteTemplateId, TestDef } from '../types'

const API_BASE = '/api'

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  })
  if (!res.ok) {
    let msg = await res.text()
    try { msg = JSON.parse(msg).error || msg } catch {}
    throw new Error(msg || `API ${res.status}`)
  }
  return res.json()
}

export const api = {
  // 根路径与扫描 (FR-01/02)
  getRoots: () => request<any[]>('/roots'),
  addRoot: (path: string) => request<any>('/roots', { method: 'POST', body: JSON.stringify({ path }) }),
  removeRoot: (id: string) => request<any>(`/roots/${id}`, { method: 'DELETE' }),
  scan: () => request<{ ok: boolean; courses: number }>('/scan', { method: 'POST' }),
  getCourses: () => request<any[]>('/courses'),

  // 文件 (FR-04/05/12)
  getFileTree: (courseId: string) => request<any>(`/courses/${encodeURIComponent(courseId)}/tree`),
  getDirectory: (courseId: string, dir: string, sort: 'name' | 'size' | 'mtime' = 'name') =>
    request<{ path: string; nodes: any[]; fileCount: number; dirCount: number; truncated: boolean }>(
      `/courses/${encodeURIComponent(courseId)}/tree?dir=${encodeURIComponent(dir)}&sort=${sort}`),
  searchCourseFiles: (courseId: string, q: string) =>
    request<Array<{ path: string; name: string; type: 'file' | 'directory' }>>(
      `/courses/${encodeURIComponent(courseId)}/search?q=${encodeURIComponent(q)}`),
  getFlatFiles: (courseId: string) =>
    request<Array<{ path: string; role?: string; score?: number; lines?: number }>>(`/courses/${encodeURIComponent(courseId)}/files`),
  getIndexSummary: (courseId: string) =>
    request<any>(`/courses/${encodeURIComponent(courseId)}/index`),
  refreshIndex: (courseId: string) =>
    request<any>(`/courses/${encodeURIComponent(courseId)}/index/refresh`, { method: 'POST', body: '{}' }),
  getSymbols: (courseId: string, path: string) =>
    request<{ symbols: Array<{ name: string; kind: string; line: number; end: number; doc: string }>; lang: string; lines: number; readingMinutes: number; role?: string; score?: number; importedBy?: number }>(
      `/courses/${encodeURIComponent(courseId)}/symbols?path=${encodeURIComponent(path)}`),
  getFileContent: (courseId: string, path: string) =>
    request<any>(`/courses/${encodeURIComponent(courseId)}/file?path=${encodeURIComponent(path)}`),
  getBookmarks: (courseId: string) => request<Record<string, number[]>>(`/bookmarks?courseId=${encodeURIComponent(courseId)}`),
  setBookmarks: (courseId: string, path: string, lines: number[]) =>
    request<{ lines: number[] }>('/bookmarks', { method: 'PUT', body: JSON.stringify({ courseId, path, lines }) }),

  // 路线 (FR-07~11)
  getRoutes: (courseId: string) => request<any[]>(`/courses/${encodeURIComponent(courseId)}/routes`),
  getRouteTemplates: () => request<RouteTemplate[]>('/route-templates'),
  createRoute: (courseId: string, route: any) => request<any>(`/courses/${encodeURIComponent(courseId)}/routes`, { method: 'POST', body: JSON.stringify(route) }),
  updateRoute: (courseId: string, routeId: string, route: any) => request<any>(`/courses/${encodeURIComponent(courseId)}/routes/${routeId}`, { method: 'PUT', body: JSON.stringify(route) }),
  deleteRoute: (courseId: string, routeId: string) => request<any>(`/courses/${encodeURIComponent(courseId)}/routes/${routeId}`, { method: 'DELETE' }),
  duplicateRoute: (courseId: string, routeId: string) => request<any>(`/courses/${encodeURIComponent(courseId)}/routes/${routeId}/duplicate`, { method: 'POST', body: '{}' }),
  setDefaultRoute: (courseId: string, routeId: string) => request<any>(`/courses/${encodeURIComponent(courseId)}/routes/${routeId}/default`, { method: 'POST', body: '{}' }),
  autoDraftRoute: (courseId: string, templateId?: RouteTemplateId, name?: string) => request<any>(`/courses/${encodeURIComponent(courseId)}/routes/draft`, { method: 'POST', body: JSON.stringify({ templateId, name }) }),
  importMdRoute: (data: { courseId: string; mdPath: string; routeName?: string; section?: string; templateId?: RouteTemplateId }) =>
    request<any>('/routes/import-md', { method: 'POST', body: JSON.stringify(data) }),
  genAiRoute: (courseId: string, prompt?: string, templateId?: RouteTemplateId) =>
    request<{ steps: any[]; warnings?: string[]; error?: string }>('/routes/gen-ai', { method: 'POST', body: JSON.stringify({ courseId, prompt, templateId }) }),

  // 进度 (FR-20/21/23)
  getRouteProgress: (routeId: string) => request<Record<string, any>>(`/routes/${routeId}/progress`),
  updateStepProgress: (courseId: string, routeId: string, stepId: string, patch: any) =>
    request<any>(`/steps/${courseId}|${routeId}|${stepId}/progress`, { method: 'PUT', body: JSON.stringify(patch) }),

  // 笔记 (FR-22)
  getNotes: (courseId?: string, stepId?: string) => {
    const params = new URLSearchParams()
    if (courseId) params.set('courseId', courseId)
    if (stepId) params.set('stepId', stepId)
    return request<any[]>(`/notes?${params}`)
  },
  saveNote: (note: any) => request<any>('/notes', { method: 'POST', body: JSON.stringify(note) }),
  deleteNote: (id: string) => request<any>(`/notes/${id}`, { method: 'DELETE' }),
  searchNotes: (q: string) => request<any[]>(`/notes/search?q=${encodeURIComponent(q)}`),

  // 看板 (FR-24/25)
  getDashboard: () => request<any>('/dashboard'),

  // 验证 (FR-15~17)
  staticCheck: (courseId: string, path: string) =>
    request<any>('/check', { method: 'POST', body: JSON.stringify({ courseId, path }) }),
  staticCheckBatch: (courseId: string, paths: string[]) =>
    request<Array<{ path: string; ok: boolean; issues: number; unavailable?: boolean }>>('/check/batch', { method: 'POST', body: JSON.stringify({ courseId, paths }) }),
  runTest: (data: { courseId: string; path: string; testDef: TestDef; routeId?: string; stepId?: string }) =>
    request<any>('/test/run', { method: 'POST', body: JSON.stringify(data) }),
  getTestDef: (courseId: string, path: string) =>
    request<any>(`/tests?courseId=${encodeURIComponent(courseId)}&path=${encodeURIComponent(path)}`),
  saveTestDef: (courseId: string, path: string, testDef: TestDef) =>
    request<any>('/tests', { method: 'POST', body: JSON.stringify({ courseId, path, testDef }) }),

  // 预览 (FR-19)
  createPreview: (courseId: string, path: string) =>
    request<{ token: string; url: string; kind: string }>('/preview', { method: 'POST', body: JSON.stringify({ courseId, path }) }),

  // 设置 (FR-26/30)
  getSettings: () => request<any>('/settings'),
  saveSettings: (settings: any) => request<any>('/settings', { method: 'PUT', body: JSON.stringify(settings) }),

  // 备份 (FR-31)
  exportBackup: () => request<{ file: string; size: number }>('/backup/export', { method: 'POST' }),
  listBackups: () => request<Array<{ file: string; size: number; mtime: number }>>('/backup/list'),
  importBackup: (file: string) => request<any>('/backup/import', { method: 'POST', body: JSON.stringify({ file }) }),

  // AI (FR-27~29)
  aiExplain: (data: any) => request<{ content?: string; error?: string }>('/ai/explain', { method: 'POST', body: JSON.stringify(data) }),
  aiChat: (data: any) => request<{ content?: string; error?: string }>('/ai/chat', { method: 'POST', body: JSON.stringify(data) }),
  aiTest: () => request<{ ok: boolean; message: string }>('/ai/test', { method: 'POST', body: '{}' }),
  // FR-29 教程/注释翻译：只提交非代码内容；courseId 由调用方按当前课程传入；
  // 不自动拼接 API Key、文件路径或整个 tab 内容；错误形状与 aiExplain/aiChat 一致。
  aiTranslate: (data: { courseId?: string; text: string; targetLang?: 'zh'; context?: string }) =>
    request<{ content?: string; error?: string }>('/ai/translate', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  // 批量翻译：一次请求译完整个文件的注释块（浏览器翻译式整页渲染的服务端接口）
  aiTranslateBatch: (data: { courseId?: string; blocks: string[]; context?: string }) =>
    request<{ contents?: string[]; error?: string }>('/ai/translate-batch', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
}
