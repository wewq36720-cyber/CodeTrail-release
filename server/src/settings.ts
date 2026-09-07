import { getLddPath } from './db/index.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const SETTINGS_FILE = join(getLddPath(), 'settings.json')

export interface AiSettings {
  provider: 'anthropic' | 'openai' | 'deepseek' | 'opencode' | 'compatible'
  apiKey: string
  model: string
  baseURL?: string
  maxTokens: number
  temperature: number
  thinking?: 'low' | 'medium' | 'high'
  identity?: 'teacher' | 'operator' | 'analyst' | 'tester'
}

export interface Settings {
  roots: Array<{ id: string; path: string; addedAt: number }>
  ai?: AiSettings
  scanCache?: Record<string, number>
  debug?: boolean
  ui?: {
    theme: 'light' | 'dark'
    fontSize: number
  }
}

let cachedSettings: Settings | null = null

function getDefaultSettings(): Settings {
  return {
    roots: [],
    ai: {
      provider: 'anthropic',
      apiKey: '',
      model: 'claude-sonnet-4-5',
      baseURL: 'https://api.anthropic.com',
      maxTokens: 4096,
      temperature: 0.2,
      thinking: 'medium',
      identity: 'teacher'
    },
    scanCache: {},
    debug: false,
    ui: { theme: 'dark', fontSize: 14 }
  }
}

export function initSettings() {
  if (existsSync(SETTINGS_FILE)) {
    try {
      const loaded = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      cachedSettings = { ...getDefaultSettings(), ...loaded }
      // 老数据补齐新增字段，避免 undefined 传给 AI 请求；空字符串同样回退默认
      if (cachedSettings!.ai) cachedSettings!.ai = withAiDefaults({ ...getDefaultSettings().ai!, ...cachedSettings!.ai })
    } catch {
      cachedSettings = getDefaultSettings()
    }
  } else {
    cachedSettings = getDefaultSettings()
  }
  persist()
}

// 空串/缺失字段回退默认值（防止历史脏数据把 provider/model 置空）
function withAiDefaults(ai: AiSettings): AiSettings {
  const d = getDefaultSettings().ai!
  return {
    provider: ['openai', 'anthropic', 'deepseek', 'opencode', 'compatible'].includes(ai.provider) ? ai.provider : d.provider,
    apiKey: sanitizeStoredKey(ai.apiKey ?? ''),
    model: ai.model || d.model,
    baseURL: ai.baseURL || d.baseURL,
    maxTokens: Number(ai.maxTokens) > 0 ? ai.maxTokens : d.maxTokens,
    temperature: Number.isFinite(Number(ai.temperature)) ? Number(ai.temperature) : d.temperature,
    thinking: ai.thinking === 'low' || ai.thinking === 'high' ? ai.thinking : 'medium',
    identity: ['teacher', 'operator', 'analyst', 'tester'].includes(ai.identity || '') ? ai.identity : 'teacher'
  }
}

// 掩码串曾被当作真实 Key 存盘的事故修复：含 • 的存储值一律视为未配置
function sanitizeStoredKey(key: string): string {
  return key.includes('•') ? '' : key
}

function persist() {
  if (cachedSettings) {
    writeFileSync(SETTINGS_FILE, JSON.stringify(cachedSettings, null, 2))
  }
}

export function getSettings(): Settings {
  if (!cachedSettings) initSettings()
  return cachedSettings!
}

// API 回传用：密钥脱敏（NF-02：密钥不回传明文给前端渲染）
const MASK = '••••••••(已配置)'
export function getSettingsMasked(): Settings {
  const s = JSON.parse(JSON.stringify(getSettings()))
  if (s.ai?.apiKey) s.ai.apiKey = MASK
  return s
}

export function saveSettings(patch: Partial<Settings>): Settings {
  // 先在旧缓存被 patch 整体覆盖前取出各段旧值（E2E 复盘缺陷①：
  // 之前 cachedSettings 先被替换，守卫再 getSettings() 读到的已是补丁里的掩码）
  const prev = getSettings()
  const prevAi = prev.ai
  cachedSettings = { ...prev, ...patch }
  if (patch.ai) {
    const merged = { ...prevAi, ...patch.ai }
    // 前端把掩码原样传回（或编辑时残留 • 前缀）= 未修改，保留真实 Key；
    // 想清空 Key 请显式传 apiKey: ''
    const incoming = patch.ai.apiKey
    if (incoming === undefined || incoming.includes('•')) merged.apiKey = prevAi?.apiKey || ''
    cachedSettings.ai = withAiDefaults(merged as AiSettings)
  }
  if (patch.ui) cachedSettings.ui = { ...prev.ui, ...patch.ui }
  if (patch.scanCache) cachedSettings.scanCache = { ...prev.scanCache, ...patch.scanCache }
  persist()
  return cachedSettings
}

export function getRoots() {
  return getSettings().roots
}

export function getAiConfig() {
  return getSettings().ai
}

export function isDebug() {
  return !!getSettings().debug
}
