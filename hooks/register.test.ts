import { expect, test } from 'claude-code/testing'

import { collect, register } from './register'
import { buildEnhancePrompt, parseEnhance } from './enhance'

const draw = ($: any) =>
  $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} as any })
const press = ($: any, key: string) => $.ui.press({ plugin: 'prompt-enhancer', key })
const NL = String.fromCharCode(10)

/**
 * What the last fill put in the prompt bar. Set by the `prompt.fill` stand-in,
 * so a test can assert what actually landed rather than only what was drawn.
 */
let filledWith: string | null = null

/**
 * Every engine call the mod makes on the way to a rewrite, faked. A test may
 * swap any of them: each event may be registered only once, so `over` is
 * applied as the registration itself rather than as a second one.
 */
const standIns = (on: any, over: Record<string, () => any> = {}) => {
  filledWith = null
  const fake = (event: string, answer: () => any) =>
    on(event, over[event] ? over[event] : answer)
  fake('ui.render', () => ({ type: 'Box', children: [] }))
  fake('prompt.read', () => ({ value: { text: 'make it better', cursor: 15 } }))
  fake('prompt.fill', ($: any, e: any) => { filledWith = e.text; return { isFilled: true } })
  fake('model.fork', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  fake('model.complete', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  fake('session.model', () => ({ value: 'claude-opus-5-5' }))
  fake('ui.status', () => ({ value: undefined }))
  fake('ui.log', () => ({ value: undefined }))
}

test('the band offers Enhance', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Enhance"')
})

// The chord is what works from the composer. The band drew `e:` here instead,
// which named a letter that does nothing unless the band holds the keyboard.
test('the chord sits outside the button, not inside its label', async ($, on) => {
  standIns(on)
  const band = JSON.stringify(await draw($, on))
  // The chord is its own Text, drawn before the button.
  expect(band).toContain('"children":["Ctrl+E:"]')
  // The button brackets its own label, so the chord must not be in that label.
  expect(band).toContain('"label":"Enhance"')
  expect(band).not.toContain('"label":"Ctrl+E')
})

test('the Enhance button carries an e hotkey', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('"hotkey":"e"')
})

// The chord is written the way a keycap is: `Ctrl+E:`, not `ctrl+e` or `e:`.
test('the chord is capitalised, and the bare letter is not advertised', async ($, on) => {
  standIns(on)
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('Ctrl+E:')
  expect(band).not.toContain('ctrl+e')
  expect(band).not.toContain('e: [')
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
    skills: ['dataviz'],
    questions: [{ question: 'One dataset or many?', options: ['One', 'Many'] }],
    result: 'A chart.',
    text: 'Body.',
  }))
  expect(parsed?.text).toBe('Body.')
  expect(parsed?.questions).toHaveLength(1)
  expect(parsed?.questions[0].options).toEqual(['One', 'Many'])
})

// A dialog needs something to pick. A question with fewer than two options
// cannot be shown as a choice, so it is dropped rather than asked empty.
test('a question with too few options is dropped', () => {
  const parsed = parseEnhance(JSON.stringify({
    skills: [],
    questions: [
      { question: 'No options?', options: [] },
      { question: 'One option?', options: ['Only'] },
      { question: 'Two?', options: ['A', 'B'] },
    ],
    result: '',
    text: 'Body.',
  }))
  expect(parsed?.questions).toHaveLength(1)
  expect(parsed?.questions[0].question).toBe('Two?')
})

// The old shape, a bare string, no longer fits the question contract.
test('a plain-string question is dropped', () => {
  const parsed = parseEnhance(JSON.stringify({
    skills: [], questions: ['One dataset or many?'], result: '', text: 'Body.',
  }))
  expect(parsed?.questions).toHaveLength(0)
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

// The Lyra borrowings: diagnose before rewriting, shape by task, guard the role.
test('the rules diagnose, shape by task, and guard the role', () => {
  const text = buildEnhancePrompt('make it better', [])
  expect(text).toContain('Diagnose before rewriting')
  expect(text).toContain('Match the shape to the task')
  expect(text).toContain('code or debugging')
  expect(text).toContain('Name a role only where it sharpens')
})

test('answers from a first pass are written into the second', () => {
  const text = buildEnhancePrompt('make it better', [], { cwd: '', claudeMd: '' }, [
    { question: 'Password login, SSO, or both?', answer: 'Both' },
  ])
  expect(text).toContain('Decisions so far')
  expect(text).toContain('Password login, SSO, or both? → Both')
  expect(text).toContain('do not ask them again')
})

test('a refused fill is reported, not thrown', async ($, on) => {
  standIns(on, { 'prompt.fill': () => ({ isFilled: false, refusal: 'dialog' }) })
  await draw($, on)
  await press($, 'enhance')
  // The band still offers Enhance, because nothing was applied.
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Enhance"')
})

test('a successful fill switches the band to Revert', async ($, on) => {
  standIns(on)
  await draw($, on)
  await press($, 'enhance')
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('"label":"Revert"')
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
  expect(band).toContain('"label":"Enhance"')
})

test('a call that came back unanswered names the reason', async ($, on) => {
  standIns(on, {
    'model.fork': () => ({ value: { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit' } }),
  })
  await draw($, on)
  await press($, 'enhance')
  expect(JSON.stringify(await draw($, on))).toContain('429')
})

// The first pass asks; the answer comes back in a second pass that lands.
test('an answered question shapes a second rewrite', async ($, on) => {
  const asked: { question: string; options: readonly string[] }[] = []
  const prompts: string[] = []
  const asked$ = {
    ui: {
      ask: async (question: string, options: readonly string[]) => {
        asked.push({ question, options })
        return 'Both'
      },
    },
  }
  standIns(on, {
    'model.fork': ($: any, e: any) => {
      prompts.push(e.prompt)
      const questions = prompts.length === 1
        ? [{ question: 'Password login, SSO, or both?', options: ['Password', 'SSO', 'Both'] }]
        : []
      const text = prompts.length === 1 ? 'first' : 'second'
      return { value: { isAnswered: true, text: JSON.stringify({ skills: [], questions, result: '', text }) } }
    },
  })

  // What the dialog is asked, and what comes back.
  const answers = await collect(asked$, [{ question: 'Password login, SSO, or both?', options: ['Password', 'SSO', 'Both'] }])
  expect(asked).toHaveLength(1)
  expect(asked[0].options).toEqual(['Password', 'SSO', 'Both'])
  expect(answers).toEqual([{ question: 'Password login, SSO, or both?', answer: 'Both' }])

  // And that answer, folded into the instruction, changes the rewrite.
  const second = buildEnhancePrompt('make it better', [], { cwd: '', claudeMd: '' }, answers)
  expect(second).toContain('Password login, SSO, or both? → Both')
})

test('no questions means no dialog', async ($, on) => {
  let askedCount = 0
  const asked$ = { ui: { ask: async () => { askedCount += 1; return 'x' } } }
  expect(await collect(asked$, [])).toEqual([])
  expect(askedCount).toBe(0)
})

// At most two questions are put, however many the model asks.
test('only two questions are asked', async () => {
  let askedCount = 0
  const asked$ = { ui: { ask: async () => { askedCount += 1; return 'A' } } }
  const answers = await collect(asked$, [
    { question: 'Q1?', options: ['A', 'B'] },
    { question: 'Q2?', options: ['A', 'B'] },
    { question: 'Q3?', options: ['A', 'B'] },
  ])
  expect(askedCount).toBe(2)
  expect(answers).toHaveLength(2)
})

// A dismissed dialog ends the asking, keeping what was already answered.
test('a dismissed dialog keeps the answers so far', async () => {
  let n = 0
  const asked$ = {
    ui: {
      ask: async () => {
        n += 1
        if (n === 2) throw new Error('dismissed')
        return 'A'
      },
    },
  }
  const answers = await collect(asked$, [
    { question: 'Q1?', options: ['A', 'B'] },
    { question: 'Q2?', options: ['A', 'B'] },
  ])
  expect(answers).toHaveLength(1)
  expect(answers[0].answer).toBe('A')
})

// Dismissing the dialog must not lose the rewrite. The first pass already
// produced one, so it is what lands.
test('a dismissed dialog still lands the first rewrite', async ($, on) => {
  standIns(on, {
    'model.fork': () => ({ value: { isAnswered: true, text: JSON.stringify({
      skills: [],
      questions: [{ question: 'Q?', options: ['A', 'B'] }],
      result: '',
      text: 'first rewrite',
    }) } }),
  })
  await draw($, on)
  await press($, 'enhance')
  expect(filledWith).toBe('first rewrite')
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Revert"')
})

// The first press in every new session: a fork has no turn to fork from, and
// the person used to be told to send a message first, which is no advice at all
// when all they wanted was to rewrite the draft they were about to send.
test('no turn to fork from falls back to a completion', async ($, on) => {
  standIns(on, { 'model.fork': () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }) })
  await draw($, on)
  await press($, 'enhance')
  // The fallback answered, so the band switched to Revert rather than complaining.
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Revert"')
})

// A completion on its own can still fail, and against a provider that answers the
// non-streaming path in the wrong shape it throws. Neither may be swallowed.
test('a completion that fails is named', async ($, on) => {
  standIns(on, {
    'model.fork': () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }),
    'model.complete': () => ({ value: { isAnswered: false, reason: 'api-error', status: 503 } }),
  })
  await draw($, on)
  await press($, 'enhance')
  expect(JSON.stringify(await draw($, on))).toContain('503')
})

test('a completion that fails reaches the band', async ($, on) => {
  standIns(on, {
    'model.fork': () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }),
    // The engine rejects a call it cannot make, against a provider whose
    // non-streaming reply is the wrong shape. It has to arrive somewhere the
    // person can see it, not vanish into the `void` a press runs under.
    'model.complete': () => {
      throw new Error("undefined is not an object (evaluating 'e.flatMap')")
    },
  })
  await draw($, on)
  await press($, 'enhance')
  const band = JSON.stringify(await draw($, on))
  // The harness answers a failing stand-in with its own message, so what is
  // asserted is the shape: the failure is in the band, and the draft is intact.
  expect(band).toContain('"color":"error"')
  expect(band).toContain('"label":"Enhance"')
})
