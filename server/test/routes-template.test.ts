import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('模板归一化会保留真实步骤并生成必填槽位占位', async () => {
  const ldd = mkdtempSync(join(tmpdir(), 'codetrail-routes-template-'))
  process.env.LEARNDESK_DIR = ldd
  try {
    const routes = await import('../src/routes.ts')
    const template = routes.getRouteTemplates().find(item => item.id === 'codebase-onboarding')
    assert.ok(template)
    const steps = routes.fillTemplate([{ id: 's1', type: 'doc', title: '通读 README', file: 'README.md' }], template)
    assert.equal(steps[0]?.stage, '定位')
    assert.equal(steps[0]?.slot, 'orientation')
    assert.ok(steps.some(step => step.slot === 'entry' && step.title.includes('待填充')))
    assert.ok(steps.some(step => step.slot === 'core' && step.title.includes('待填充')))
    assert.ok(steps.some(step => step.slot === 'reflection' && step.type === 'checkpoint'))
    assert.equal(steps.find(step => step.slot === 'entry')?.file, undefined)
  } finally {
    rmSync(ldd, { recursive: true, force: true })
  }
})
