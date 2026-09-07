import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { THEMES, useTheme } from '../theme/ThemeContext'
import type { Settings } from '../types'

// 服务商预设：provider 决定协议（Anthropic 原生 / OpenAI 兼容）；中转类统一走 compatible，仅换 baseURL+模型
type AiPreset = { label: string; provider: 'anthropic' | 'openai' | 'deepseek' | 'opencode' | 'compatible'; baseURL: string; models: string[] }
const AI_PRESETS: Record<string, AiPreset> = {
  anthropic: { label: 'Anthropic（原生）', provider: 'anthropic', baseURL: 'https://api.anthropic.com', models: ['claude-sonnet-4-5', 'claude-3-5-haiku'] },
  openai: { label: 'OpenAI', provider: 'openai', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4.1-mini'] },
  deepseek: { label: 'DeepSeek', provider: 'deepseek', baseURL: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
  opencode: { label: 'OpenCode Go', provider: 'opencode', baseURL: 'https://opencode.ai/zen/v1', models: ['opencode-go'] },
  moonshot: { label: 'Kimi · Moonshot', provider: 'compatible', baseURL: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'] },
  zhipu: { label: '智谱 GLM', provider: 'compatible', baseURL: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4-plus'] },
  dashscope: { label: '阿里通义 DashScope', provider: 'compatible', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'] },
  volcengine: { label: '火山方舟 Doubao', provider: 'compatible', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-pro-32k', 'doubao-1-5-pro-32k-250115'] },
  siliconflow: { label: '硅基流动 SiliconFlow', provider: 'compatible', baseURL: 'https://api.siliconflow.cn/v1', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'] },
  groq: { label: 'Groq', provider: 'compatible', baseURL: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'gemma2-9b-it'] },
  openrouter: { label: 'OpenRouter 聚合', provider: 'compatible', baseURL: 'https://openrouter.ai/api/v1', models: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat'] },
  compatible: { label: '自定义 OpenAI 兼容中转', provider: 'compatible', baseURL: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'qwen-plus', 'custom'] }
}

const AI_IDENTITIES = [
  { id: 'teacher', icon: '🎓', name: '资深老师', detail: '心智模型 → 例子 → 练习' },
  { id: 'operator', icon: '🛠️', name: '专业助手', detail: '结论 → 步骤 → 风险' },
  { id: 'analyst', icon: '🔬', name: '分析专家', detail: '事实 → 推断 → 权衡' },
  { id: 'tester', icon: '🧪', name: '测试问答', detail: '复现 → 断言 → 边界' }
] as const

interface SettingsModalProps {
  onClose: () => void
  notify: (text: string, kind?: 'ok' | 'err') => void
  onRescan: () => Promise<void>
}

export function SettingsModal({ onClose, notify, onRescan }: SettingsModalProps) {
  const { theme, setTheme } = useTheme()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<'roots' | 'ai' | 'ui' | 'backup'>(() => {
    const q = new URLSearchParams(location.search).get('settings')
    return q === 'ui' || q === 'ai' || q === 'backup' ? q : 'roots'
  })
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [rootInput, setRootInput] = useState('')
  const [aiTestMsg, setAiTestMsg] = useState<string>('')
  const [backups, setBackups] = useState<Array<{ file: string; size: number; mtime: number }>>([])

  useEffect(() => {
    loadSettings()
  }, [])

  async function loadSettings() {
    try {
      setSettings(await api.getSettings())
      if (tab === 'backup') loadBackups()
    } catch (e: any) {
      notify(`加载设置失败: ${e.message}`, 'err')
    }
  }

  async function loadBackups() {
    try { setBackups(await api.listBackups()) } catch {}
  }

  useEffect(() => { if (tab === 'backup') loadBackups() }, [tab])

  async function handleSave() {
    if (!settings) return
    setSaving(true)
    try {
      await api.saveSettings(settings)
      notify('设置已保存')
      onClose()
    } catch (e: any) {
      notify(`保存失败: ${e.message}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  async function handleScan() {
    setScanning(true)
    try {
      await onRescan()
    } catch (e: any) {
      notify(`扫描失败: ${e.message}`, 'err')
    } finally {
      setScanning(false)
    }
  }

  async function handleAddRoot() {
    const path = rootInput.trim()
    if (!path) return
    try {
      await api.addRoot(path)
      setRootInput('')
      const s = await api.getSettings()
      setSettings(s)
      await handleScan()
    } catch (e: any) {
      notify(`添加失败: ${e.message}`, 'err')
    }
  }

  async function handleRemoveRoot(id: string) {
    try {
      await api.removeRoot(id)
      const s = await api.getSettings()
      setSettings(s)
      await handleScan()
      notify('已移除并重扫（进度数据保留）')
    } catch (e: any) {
      notify(`移除失败: ${e.message}`, 'err')
    }
  }

  async function handleTestAi() {
    setAiTestMsg('测试中…')
    // 先保存当前 AI 配置再测试
    try { await api.saveSettings(settings) } catch {}
    try {
      const r = await api.aiTest()
      setAiTestMsg(r.message)
      const s = await api.getSettings()
      setSettings(s)
    } catch (e: any) {
      setAiTestMsg(`失败: ${e.message}`)
    }
  }

  function applyPreset(key: string) {
    if (!settings?.ai) return
    const preset = AI_PRESETS[key] || AI_PRESETS.compatible
    setSettings({ ...settings, ai: { ...settings.ai, provider: preset.provider, baseURL: preset.baseURL, model: preset.models[0] } })
  }

  async function handleExportBackup() {
    try {
      const res = await api.exportBackup()
      notify(`导出成功: ${res.file}（${(res.size / 1024).toFixed(1)} KB）`)
      loadBackups()
    } catch (e: any) {
      notify(`导出失败: ${e.message}`, 'err')
    }
  }

  async function handleImportBackup(file: string) {
    if (!confirm(`导入备份「${file}」将覆盖当前数据（导入前自动备份原库）。继续？`)) return
    try {
      const r = await api.importBackup(file)
      notify(r.message, r.ok ? 'ok' : 'err')
    } catch (e: any) {
      notify(`导入失败: ${e.message}`, 'err')
    }
  }

  if (!settings) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⚙ 设置</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-tabs">
          <button className={tab === 'roots' ? 'active' : ''} onClick={() => setTab('roots')}>📁 根路径</button>
          <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>🤖 AI</button>
          <button className={tab === 'ui' ? 'active' : ''} onClick={() => setTab('ui')}>🎨 界面</button>
          <button className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>💾 备份</button>
        </div>

        <div className="modal-content">
          {tab === 'roots' && (
            <div className="settings-section">
              <h3>学习根路径</h3>
              <p className="hint">添加包含学习项目的目录，平台自动扫描识别课程（重启后保留）</p>
              <ul className="roots-list">
                {settings.roots.map(root => (
                  <li key={root.id} className="root-item">
                    <span className="root-path">{root.path}</span>
                    <span className="root-date">添加于 {new Date(root.addedAt).toLocaleString()}</span>
                    <button className="btn-mini danger" onClick={() => handleRemoveRoot(root.id)}>移除</button>
                  </li>
                ))}
                {settings.roots.length === 0 && <li className="empty-root">暂无根路径，点击下方添加</li>}
              </ul>
              <div className="add-root-form">
                <input
                  type="text"
                  placeholder="例如: D:\Study"
                  className="root-input"
                  value={rootInput}
                  onChange={e => setRootInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddRoot()}
                />
                <button className="btn-primary" onClick={handleAddRoot}>添加并扫描</button>
                <button className="btn-secondary" onClick={handleScan} disabled={scanning}>{scanning ? '扫描中…' : '重新扫描'}</button>
              </div>
            </div>
          )}

          {tab === 'ai' && (
            <div className="settings-section">
              <h3>AI provider 与模型</h3>
              <p className="hint">预设只填写兼容端点与常用模型，API Key 仍只保存在本机。选服务商后仍可微调 Base URL / 模型；思考强度对不认识该参数的中转会自动降级重试。</p>
              <div className="form-group">
                <label>服务商预设</label>
                <select
                  value={Object.keys(AI_PRESETS).find(k => AI_PRESETS[k].baseURL === (settings.ai?.baseURL || '')) || 'compatible'}
                  onChange={e => applyPreset(e.target.value)}
                >
                  {Object.entries(AI_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input
                  type="password"
                  // GET 回传的是掩码：输入框不回填掩码（编辑会污染 Key），留空 = 不修改
                  value={settings.ai?.apiKey?.includes('•') ? '' : (settings.ai?.apiKey || '')}
                  onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, apiKey: e.target.value } })}
                  placeholder={settings.ai?.apiKey?.includes('•') ? '已配置（留空则不修改；输入可更换）' : 'sk-...'}
                />
                <p className="hint">密钥仅保存在本机 .learndesk/settings.json，不随看板/备份导出</p>
              </div>
              <div className="form-group">
                <label>模型</label>
                <select
                  value={settings.ai?.model || ''}
                  onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, model: e.target.value } })}
                >
                  {Array.from(new Set([...(AI_PRESETS[Object.keys(AI_PRESETS).find(k => AI_PRESETS[k].baseURL === (settings.ai?.baseURL || '')) || 'compatible']?.models || []), settings.ai?.model || ''])).filter(Boolean).map(model => <option key={model} value={model}>{model}</option>)}
                </select>
                <input
                  type="text"
                  value={settings.ai?.model || ''}
                  onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, model: e.target.value } })}
                  placeholder="也可直接输入自定义模型 ID"
                />
              </div>
              <div className="form-group">
                <label>Base URL（可选，兼容中转）</label>
                <input
                  type="text"
                  value={settings.ai?.baseURL || ''}
                  onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, baseURL: e.target.value } })}
                  placeholder="https://api.anthropic.com"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Max Tokens</label>
                  <input
                    type="number"
                    value={settings.ai?.maxTokens ?? 4096}
                    onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, maxTokens: parseInt(e.target.value) || 4096 } })}
                  />
                </div>
                <div className="form-group">
                  <label>Temperature</label>
                  <input
                    type="number" step="0.1" min="0" max="2"
                    value={settings.ai?.temperature ?? 0.2}
                    onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, temperature: parseFloat(e.target.value) || 0 } })}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>思考强度</label>
                  <select
                    value={settings.ai?.thinking || 'medium'}
                    onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, thinking: e.target.value as 'low' | 'medium' | 'high' } })}
                  >
                    <option value="low">低 · 速度优先</option>
                    <option value="medium">中 · 平衡</option>
                    <option value="high">高 · 分析优先</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>默认助手身份</label>
                  <select
                    value={settings.ai?.identity || 'teacher'}
                    onChange={e => setSettings({ ...settings, ai: { ...settings.ai!, identity: e.target.value as 'teacher' | 'operator' | 'analyst' | 'tester' } })}
                  >
                    {AI_IDENTITIES.map(identity => <option key={identity.id} value={identity.id}>{identity.icon} {identity.name} · {identity.detail}</option>)}
                  </select>
                </div>
              </div>
              <div className="toolbar-row">
                <button className="btn-secondary" onClick={handleTestAi}>测试连通</button>
                {aiTestMsg && <span className={`ai-test-msg ${aiTestMsg.startsWith('连接成功') ? 'ok' : ''}`}>{aiTestMsg}</span>}
              </div>
            </div>
          )}

          {tab === 'ui' && (
            <div className="settings-section">
              <h3>主题</h3>
              <p className="hint">五套配色 = 五个主题，选中即全站换肤（含编辑器与 AI 助手），保存在本机浏览器、多标签页同步。</p>
              <div className="theme-grid">
                {THEMES.map(t => (
                  <button key={t.id} className={`theme-card ${theme === t.id ? 'on' : ''}`} onClick={() => setTheme(t.id)} title={t.note}>
                    <span className="sw"><i style={{ background: t.bg }} /><i className="a" style={{ background: t.accent }} /></span>
                    <span className="nm">{t.name}</span>
                  </button>
                ))}
              </div>
              <h3>编辑器</h3>
              <div className="form-group">
                <label>字体大小</label>
                <input
                  type="number" min="10" max="24" style={{ width: 120 }}
                  value={settings.ui?.fontSize || 14}
                  onChange={e => setSettings({ ...settings, ui: { ...settings.ui!, fontSize: parseInt(e.target.value) || 14 } })}
                />
              </div>
            </div>
          )}

          {tab === 'backup' && (
            <div className="settings-section">
              <h3>数据备份与迁移（FR-31）</h3>
              <p className="hint">备份 = 进度(db) + 路线 + 测试定义 + 笔记 的 zip 快照；不含 AI Key。文件位于 .learndesk/backups/。</p>
              <div className="backup-actions">
                <button className="btn-primary" onClick={handleExportBackup}>导出快照</button>
              </div>
              <h4>可用备份</h4>
              <ul className="roots-list">
                {backups.map(b => (
                  <li key={b.file} className="root-item">
                    <span className="root-path">{b.file}</span>
                    <span className="root-date">{(b.size / 1024).toFixed(1)} KB · {new Date(b.mtime).toLocaleString()}</span>
                    <button className="btn-mini" onClick={() => handleImportBackup(b.file)}>导入</button>
                  </li>
                ))}
                {backups.length === 0 && <li className="empty-root">暂无备份</li>}
              </ul>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存并关闭'}
          </button>
        </div>
      </div>
    </div>
  )
}
