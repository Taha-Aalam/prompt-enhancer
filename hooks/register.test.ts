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

/** Every text a fill put in the box, in order. */
let fills: string[] = []

/** Every prompt `Send` submitted, in order. */
let submitted: { text: string; asUser: boolean }[] = []

/** What the box holds; a test types by changing it, as the engine would. */
let boxText = 'make it better'

/**
 * Every engine call the mod makes on the way to a rewrite, faked. A test may
 * swap any of them: each event may be registered only once, so `over` is
 * applied as the registration itself rather than as a second one.
 */
const standIns = (on: any, over: Record<string, () => any> = {}) => {
  filledWith = null
  fills = []
  submitted = []
  boxText = 'make it better'
  const fake = (event: string, answer: () => any) =>
    on(event, over[event] ? over[event] : answer)
  fake('ui.render', () => ({ type: 'Box', children: [] }))
  fake('prompt.read', () => ({ value: { text: boxText, cursor: boxText.length } }))
  fake('prompt.fill', ($: any, e: any) => {
    filledWith = e.text
    fills.push(e.text)
    // The engine's own fill lands in the box, so a later read sees it.
    if (e.mode === 'replace' || e.mode === undefined) boxText = e.text
    return { isFilled: true }
  })
  // `asUser` is not on the hook's input: it rides on the origin the engine
  // stamps for a plugin's submission.
  fake('prompt.submit', ($: any, e: any) => {
    submitted.push({ text: e.text, asUser: e.origin?.asUser === true })
    return { text: e.text }
  })
  fake('prompt.edit', ($: any, e: any) => {
    boxText = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text: boxText, cursor: e.start + e.inputText.length }
  })
  fake('prompt.change', ($: any, e: any) => { boxText = e.text; return { text: e.text } })
  fake('model.fork', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  fake('model.complete', () => ({ value: { isAnswered: true, text: '{"text":"rewritten"}' } }))
  fake('session.model', () => ({ value: 'claude-opus-5-5' }))
  fake('ui.status', () => ({ value: undefined }))
  fake('ui.log', () => ({ value: undefined }))
}

/** Types `text` into the box as a key does, through the `prompt.edit` chain. */
const typeInto = ($: any, text: string, before = boxText) =>
  $.prompt.edit({
    origin: { kind: 'composer' },
    text: before,
    cursor: before.length,
    start: before.length,
    end: before.length,
    inputText: text,
  })

/** Takes the whole draft back out, as Backspace at the end of it would. */
const emptyBox = ($: any, before = boxText) =>
  $.prompt.edit({
    origin: { kind: 'composer' },
    text: before,
    cursor: 0,
    start: 0,
    end: before.length,
    inputText: '',
  })


test('the band offers Enhance', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Enhance"')
})

// The row is there for a draft. With the box empty there is nothing to enhance
// and nothing to send, and a band that sat there through every turn was one more
// line of chrome above a prompt it had no business describing.
test('nothing is drawn while the box is empty', async ($, on) => {
  standIns(on, { 'prompt.read': () => ({ value: { text: '', cursor: 0 } }) })
  const band = JSON.stringify(await draw($, on))
  expect(band).not.toContain('Prompt Enhancer')
  expect(band).not.toContain('"label":"Enhance"')
})

// Whitespace is not a draft: a box holding a space is one the person has not
// written anything in yet.
test('whitespace alone is not a draft', async ($, on) => {
  standIns(on, { 'prompt.read': () => ({ value: { text: '   \n ', cursor: 5 } }) })
  expect(JSON.stringify(await draw($, on))).not.toContain('Prompt Enhancer')
})

// The mods beneath still draw when this one has nothing of its own to add.
test('the empty box leaves the mods beneath their band', async ($, on) => {
  standIns(on, {
    'prompt.read': () => ({ value: { text: '', cursor: 0 } }),
    'ui.render': () => ({ type: 'Box', children: ['SOMETHING BENEATH'] }),
  })
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('SOMETHING BENEATH')
  expect(band).not.toContain('Prompt Enhancer')
})

// The band's props do not change as the person types, so the row has to be
// told when the box starts holding a draft. That is a state write, and the band
// subscribes to it by reading it while it draws.
test('the first typed character tells the row the box has a draft', async ($, on) => {
  standIns(on)
  const writes: string[] = []
  on('state.set', async ($: any, e: any, next: any) => { writes.push(`${e.key}=${JSON.stringify(e.value)}`); return next(e) })
  boxText = ''

  await typeInto($, 'm')
  await typeInto($, 'a')
  await typeInto($, 'k')
  expect(writes).toEqual(['draft=true'])
})

// And once more when the box is emptied, so the row leaves with the draft.
test('emptying the box tells the row the draft is gone', async ($, on) => {
  standIns(on)
  const writes: string[] = []
  on('state.set', async ($: any, e: any, next: any) => { writes.push(`${e.key}=${JSON.stringify(e.value)}`); return next(e) })
  boxText = ''

  await typeInto($, 'hi')
  await emptyBox($, 'hi')
  expect(writes).toEqual(['draft=true', 'draft=false'])
})

// The row reads the box, not the state, so it is right the first time it draws
// even before any edit has been seen.
test('a box that already holds a draft draws the row on the first draw', async ($, on) => {
  standIns(on)
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Enhance"')
})

// The row offers a second way out besides enhancing: send the draft exactly as
// typed. It is the same thing Enter does, so it carries no chord.
test('the band offers Send beside Enhance', async ($, on) => {
  standIns(on)
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('"label":"Send"')
  expect(band).toContain('"hotkey":"s"')
})

// Send submits the words the person typed, as their own. Without `asUser` the
// model would read them under this mod's name.
test('Send submits the draft as the person typed it', async ($, on) => {
  standIns(on)
  await draw($, on)
  await press($, 'send')
  expect(submitted).toEqual([{ text: 'make it better', asUser: true }])
})

// The box is emptied before the prompt is submitted, not after: a prompt sent
// while a turn runs is queued, and text left in the box through all of it
// invites a second send.
test('Send empties the box before it submits', async ($, on) => {
  standIns(on)
  await draw($, on)
  await press($, 'send')
  expect(fills).toEqual([''])
  expect(submitted).toHaveLength(1)
})

// A submission the engine drops puts the draft back, with the reason in the row,
// rather than losing what the person wrote.
test('a dropped send puts the draft back and says why', async ($, on) => {
  standIns(on, { 'prompt.submit': () => ({ drop: 'a Stop stands' }) })
  await draw($, on)
  await press($, 'send')
  expect(fills).toEqual(['', 'make it better'])
  expect(JSON.stringify(await draw($, on))).toContain('a Stop stands')
})

// A throw must not vanish into the `void` a press runs under, and must not take
// the draft with it. The harness answers a throwing stand-in with its own
// message, so what is asserted is the shape: a failure in the row, the draft
// back in the box, and the row still offering Enhance.
test('a throwing send puts the draft back and names it', async ($, on) => {
  standIns(on, {
    'prompt.submit': () => { throw new Error('the ingress is closed') },
  })
  await draw($, on)
  await press($, 'send')
  expect(fills).toEqual(['', 'make it better'])
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('"color":"error"')
  expect(band).toContain('sending failed')
  expect(band).toContain('"label":"Enhance"')
})

// A send leaves nothing to revert: the rewrite it would put back belongs to a
// draft that has gone.
test('a send leaves nothing to revert', async ($, on) => {
  standIns(on)
  await draw($, on)
  await press($, 'enhance')
  expect(JSON.stringify(await draw($, on))).toContain('"label":"Revert"')
  await press($, 'send')
  expect(JSON.stringify(await draw($, on))).not.toContain('"label":"Revert"')
})

// The box is the person's while the model works. Emptying it, editing it or
// sending it means they moved on, so a rewrite still in flight must not land
// over what they did instead.
test('a rewrite is dropped where the draft left the box under it', async ($, on) => {
  standIns(on, {
    'model.fork': async () => {
      // What the person does while the model is thinking: the box is emptied.
      boxText = ''
      return { value: { isAnswered: true, text: '{"text":"rewritten"}' } }
    },
  })
  await draw($, on)
  await press($, 'enhance')
  expect(filledWith).toBe(null)
  expect(JSON.stringify(await draw($, on))).not.toContain('rewritten')
})

// A failure is said about a draft. A draft that has gone leaves nothing to
// describe, and holding the complaint would greet the next draft with a
// remark about the one before it.
test('a failure about a draft that left the box is not held', async ($, on) => {
  standIns(on, {
    'model.fork': async () => {
      boxText = ''
      return { value: { isAnswered: false, reason: 'api-error', status: 500 } }
    },
  })
  await draw($, on)
  await press($, 'enhance')
  // The box is empty, so the row is not drawn at all — and nothing is held for
  // the next draft.
  expect(JSON.stringify(await draw($, on))).not.toContain('500')
  boxText = 'a new draft'
  expect(JSON.stringify(await draw($, on))).not.toContain('500')
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

// `AbovePrompt` is one site shared by every mod. The hook used to answer it without
// `next`, which took the whole site: skins' usage band and any other mod's band
// beneath it never drew. What is drawn beneath is kept and laid under our row.
test('the band keeps what the mods beneath it drew', async ($, on) => {
  standIns(on, {
    'ui.render': () => ({ type: 'Box', children: ['SOMETHING BENEATH'] }),
  })
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('🪄 Prompt Enhancer')
  expect(band).toContain('SOMETHING BENEATH')
})

// Claude Code's own placeholder is never nested: a surface drops a band that nests
// it, so it is left out and only the mods' drawings are kept.
test('the engine placeholder is not nested', async ($, on) => {
  standIns(on, {
    'ui.render': () => ({ type: 'engine' }),
  })
  const band = JSON.stringify(await draw($, on))
  expect(band).toContain('🪄 Prompt Enhancer')
  expect(band).not.toContain('"type":"engine"')
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
