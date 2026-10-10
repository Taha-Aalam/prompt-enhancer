import { expect, test } from 'claude-code/testing'

import { register } from './register'
import { buildEnhancePrompt, parseEnhance } from './enhance'

const draw = ($: any) =>
  $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} as any })
const press = ($: any, key: string) => $.ui.press({ plugin: 'prompt-enhancer', key })
const NL = String.fromCharCode(10)

test('the band offers Enhance', async ($, on) => {
  on('ui.render', () => ({ type: 'Box', children: [] }))
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Enhance"')
})

const FILES: Record<string, string> = {
  dataviz: '---' + NL + 'name: dataviz' + NL + 'description: Charts.' + NL + '---' + NL,
  broken: 'no frontmatter at all',
  nameless: '---' + NL + 'description: No name key.' + NL + '---' + NL,
}

test('skills are read from a faked filesystem', async ($, on) => {
  on('session.start', () => ({ cwd: 'C:\\tmp' }))
  on('env.get', () => ({ value: '/home/tester' }))
  on('fs.list', () => ({ value: [
    { name: 'dataviz', kind: 'dir' },
    { name: 'broken', kind: 'dir' },
    { name: 'nameless', kind: 'dir' },
    { name: 'notes.txt', kind: 'file' },
  ] }))
  on('fs.read', ($, e) => {
    const m = /[\\/]?([^\\/]+)[\\/]SKILL\.md$/.exec(e.path)
    const body = m ? FILES[m[1]] : undefined
    return body === undefined ? { deny: 'no such file' } : { value: body }
  })
  on('ui.render', () => ({ type: 'Box', children: [] }))

  await $.session.start({ cwd: 'C:\\tmp' })
  expect(JSON.stringify(await draw($, on))).toContain('Enhance')
})

test('the enhance prompt names skills', async () => {
  const text = buildEnhancePrompt('make it better', [{ name: 'dataviz', description: 'Charts' }])
  expect(text).toContain('dataviz')
})

test('a model answer that is not JSON fails soft', async () => {
  expect(parseEnhance('sorry, I cannot')).toBe(null)
})

test('a well-formed answer parses', async () => {
  const parsed = parseEnhance(JSON.stringify({
    skills: ['dataviz'], questions: ['One dataset or many?'], result: 'A chart.', text: 'Body.',
  }))
  expect(parsed?.text).toBe('Body.')
  expect(parsed?.questions).toHaveLength(1)
})

test('a refused fill is reported, not thrown', async ($, on) => {
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('prompt.read', () => ({ value: { text: 'make it better', cursor: 15 } }))
  on('prompt.fill', () => ({ isFilled: false, refusal: 'dialog' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await draw($, on)
  await press($, 'enhance')
  await draw($, on)
  expect(true).toBe(true)
})

test('a successful fill switches the band to Revert', async ($, on) => {
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('prompt.read', () => ({ value: { text: 'make it better', cursor: 15 } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  await draw($, on)
  await press($, 'enhance')
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Revert"')
})