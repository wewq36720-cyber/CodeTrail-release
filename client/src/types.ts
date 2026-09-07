export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  mtime?: number
  children?: FileNode[]
  group?: string
  isRouteFile?: boolean
  role?: 'core' | 'entry' | 'example' | 'doc' | 'test' | 'config' | 'other'
  score?: number
}

export interface TreeResponse {
  tree: FileNode[]
  groups: string[]
  truncated: boolean
  totalFiles: number
}

export interface Course {
  id: string
  kind: 'repo' | 'docs'
  root: string
  slug: string
  lang: string
  label: string
  tags: string[]
  scan_meta: string | Record<string, any>
  missing?: number
  last_scan_at: number
}

export interface Step {
  id: string
  type: 'file' | 'doc' | 'test' | 'checkpoint'
  title: string
  file?: string
  range?: [number, number]
  note?: string
  testRef?: string
  stage?: string
  slot?: string
}

export interface Route {
  id: string
  courseId: string
  name: string
  order: number
  is_default?: boolean
  steps: Step[]
  def_path?: string
  warnings?: string[]
  templateId?: string
}

export type RouteTemplateId =
  | 'codebase-onboarding' | 'feature-trace' | 'bug-investigation' | 'api-integration'
  | 'project-decomposition' | 'example-driven' | 'deep-module'

export interface RouteSlot {
  id: string
  stage: string
  type: Step['type']
  label: string
  required: boolean
  guide?: string
}

export interface RouteTemplate {
  id: RouteTemplateId
  name: string
  audience: string
  description: string
  stages: string[]
  slots?: RouteSlot[]
}

export interface StepProgress {
  course_id: string
  route_id: string
  step_id: string
  status: 'todo' | 'doing' | 'done' | 'skipped'
  self_rating?: number | null
  last_open_at?: number
  done_at?: number
  review_due_at?: number
}

export interface Activity {
  id: number
  at: number
  course_id: string
  route_id: string
  step_id: string
  action: string
  payload: string
}

export interface ReviewQueueItem {
  course_id: string
  course_slug: string
  route_id: string
  route_name: string
  route_label?: string
  step_id: string
  step_title: string
  stage?: string
  status: string
  self_rating?: number
  review_due_at?: number
  done_at?: number
}

export interface DashboardData {
  courses: Array<{
    course: Course
    routes: Array<{
      routeId: string
      routeName: string
      routeLabel?: string
      isDefault: boolean
      total: number
      done: number
      doing: number
      percent: number
      nextStep: { stepId: string; title: string; type: string } | null
    }>
    lastActive: number
    totalSteps: number
    totalDone: number
  }>
  heatmap: Array<{ day: string; count: number }>
  reviewQueue: ReviewQueueItem[]
    nextSteps: Array<{ stepId: string; title: string; type: string; stage?: string; courseId: string; courseName: string; routeId: string; routeName: string; routeLabel?: string }>
}

export interface Note {
  id: string
  course_id: string
  step_id?: string
  title: string
  updated_at: number
  snippet?: string
}

export type AiIdentity = 'teacher' | 'operator' | 'analyst' | 'tester'
export type AiProvider = 'anthropic' | 'openai' | 'deepseek' | 'opencode' | 'compatible'

export interface Settings {
  roots: Array<{ id: string; path: string; addedAt: number }>
  ai?: {
    provider: AiProvider
    apiKey: string
    model: string
    baseURL?: string
    maxTokens: number
    temperature: number
    thinking?: 'low' | 'medium' | 'high'
    identity?: AiIdentity
  }
  ui?: {
    theme: 'light' | 'dark'
    fontSize: number
  }
}

export interface TestDef {
  model: 'm1' | 'm2'
  cmdLang?: string
  stdin?: string
  expect?: { stdoutInclude?: string; stdoutExact?: string; exitOk?: boolean }
  entry?: string
  runtime?: string
}

export interface CheckResult {
  kind: 'static'
  ok: boolean
  items: Array<{ line: number; msg: string; src: string }>
  ms: number
  lang?: string
  unavailable?: boolean
}

export interface OpenRequest {
  path: string
  range?: [number, number]
  note?: string
  stepId?: string
  ts: number
}
