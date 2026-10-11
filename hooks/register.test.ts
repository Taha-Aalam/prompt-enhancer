import { expect, test } from 'claude-code/testing'

import { register } from './register'
import { buildEnhancePrompt, parseEnhance } from './enhance'

const draw = ($: any) =>
  $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} as any })
const press = ($: any, key: string) => $.ui.press({ plugin: 'prompt-enhancer', key })
const NL = String.fromCharCode(10)

/**
 * Every engine call the mod makes on the way to a rewrite, faked. A test may
 * swap any of them: each event may be registered only once, so `over` is
 * applied as the registration itself rather than as a second one.
 */
const standIns = (on: any, over: Record<string, () => any> = {}) => {
  const fake = (event: string, answer: () => any) =>
    on(event, over[event] ? over[event] : answer)
  fake('ui.render', () => ({ type: 'Box', children: [] }))
  fake('prompt.read', () => ({ value: { text: 'make it better', cursor: 15 } }))
  fake('prompt.fill', () => ({ isFilled: true }))
  fake('model.fork', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  fake('ui.status', () => ({ value: undefined }))
  fake('ui.log', () => ({ value: undefined }))
}

test('the band offers Enhance', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('[ Enhance ]')
})

test('the Enhance button carries an e hotkey', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('"hotkey":"e"')
})

// The chord that presses this from the prompt, as opposed to the band hotkey.
// It is what makes the button reachable without ctrl+x tab, which a terminal
// that eats a chord on a `ctrl+x` prefix would otherwise swallow.
test('the Enhance button carries a chord action', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('"action":"confirm:previousField"')
})

test('the band leads with its mark and keeps air around the button', async ($, on) => {
  standIns(on)
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('🪄 Prompt Enhancer')
  // `gap` is what separates the label from the button; without it they run together.
  expect(band).toContain('"gap":2')
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
  standIns(on)

  await $.session.start({ cwd: 'C:\\tmp' })
  expect(JSON.stringify(await draw($, on))).toContain('Enhance')
})

test('the rewrite prompt names the project and the skills', () => {
  const text = buildEnhancePrompt(
    'make it better',
    [{ name: 'dataviz', description: 'Charts' }],
    { cwd: 'C:\\work\\app', claudeMd: 'Use tabs.' },
  )
  expect(text).toContain('dataviz')
  expect(text).toContain('C:\\work\\app')
  expect(text).toContain('Use tabs.')
})

test('a model answer that is not JSON fails soft', () => {
  expect(parseEnhance('sorry, I cannot')).toBe(null)
})

test('a well-formed answer parses', () => {
  const parsed = parseEnhance(JSON.stringify({
    skills: ['dataviz'], questions: ['One dataset or many?'], result: 'A chart.', text: 'Body.',
  }))
  expect(parsed?.text).toBe('Body.')
  expect(parsed?.questions).toHaveLength(1)
})

test('a refused fill is reported, not thrown', async ($, on) => {
  standIns(on, { 'prompt.fill': () => ({ isFilled: false, refusal: 'dialog' }) })
  await draw($, on)
  await press($, 'enhance')
  // The band still offers Revert, because nothing was applied.
  expect(JSON.stringify(await draw($, on))).toContain('[ Enhance ]')
})

test('a successful fill switches the band to Revert', async ($, on) => {
  standIns(on)
  await draw($, on)
  await press($, 'enhance')
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('[ Revert ]')
  expect(band).toContain('"action":"permission:toggleDebug"')
})

test('a failing model call is shown, and the draft is left alone', async ($, on) => {
  // The bug this mod shipped with: its model call threw against some providers,
  // and the `void` a press runs under swallowed that whole, so the person saw
  // only a repeated "the rewrite did not come back" and no draft.
  standIns(on, {
    'model.fork': () => {
      throw new Error("undefined is not an object (evaluating 'e.flatMap')")
    },
  })
  await draw($, on)
  await press($, 'enhance')
  await press($, 'enhance')
  const band = JSON.stringify(await draw($, on))
  // Whatever the engine reports, it is put in front of the person rather than
  // swallowed, and nothing was rewritten, so Enhance is still what is offered.
  expect(band).toContain('"color":"error"')
  expect(band).toContain('[ Enhance ]')
})

test('a call that came back unanswered names the reason', async ($, on) => {
  standIns(on, {
    'model.fork': () => ({ value: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit' } }),
  })
  await draw($, on)
  await press($, 'enhance')
  expect(JSON.stringify(await draw($, on))).toContain('429')
})

test('no turn to fork from is named, not swallowed', async ($, on) => {
  standIns(on, { 'model.fork': () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }) })
  await draw($, on)
  await press($, 'enhance')
  expect(JSON.stringify(await draw($, on))).toContain('send a message first')
})
