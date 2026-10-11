import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Applied, Phase, Skill } from '../types'
import { buildEnhancePrompt, parseEnhance } from './enhance'
import { listSkillsWith } from './skills'

const applied = atom({ plugin: 'prompt-enhancer', key: 'applied' } as const, null)
const skills = atom({ plugin: 'prompt-enhancer', key: 'skills' } as const, [] as Skill[])
const phase = atom({ plugin: 'prompt-enhancer', key: 'phase' } as const, { kind: 'idle' } as Phase)
/** The project the session is in, as the rewrite needs to name it. */
const context = atom({ plugin: 'prompt-enhancer', key: 'context' } as const, { cwd: '', claudeMd: '' })

/** How much of the project's CLAUDE.md is worth sending. */
const MAX_CLAUDE_MD = 4_000

/**
 * Two engine actions borrowed as carriers for chords the person binds.
 *
 * A Button's `action` is pressed from the prompt — no `ctrl+x tab`, no focus
 * dance — as long as no engine handler of that action is mounted. These two are
 * the ones the keybinding reference documents as ones "Claude Code doesn't
 * respond to", so no built-in feature can take the chord out from under them.
 * Neither is bound by default; binding them in `~/.claude/keybindings.json` is
 * what puts `ctrl+e` and `ctrl+r` on these buttons (the README has the file).
 */
const ENHANCE_ACTION = 'confirm:previousField'
const REVERT_ACTION = 'permission:toggleDebug'

/**
 * The label a control is drawn with.
 *
 * `plain` already draws the hotkey in the accent color, a colon, then this, so
 * the band reads `e: [ Enhance ]` and the letter stays visible. But `plain` wins
 * over `variant`, so the surface draws no chrome box beside it and `borderStyle`
 * cannot add one — hence the brackets, which draw the same on every surface.
 */
const boxed = (label: string) => `[ ${label} ]`

/** The reason a call did not come back, in words fit to show the person. */
const why = (result: any): string => {
  if (result?.reason === 'api-error') {
    const status = result.status === null || result.status === undefined ? '' : ` (${result.status})`
    return `the model refused the request${status}: ${result.error ?? 'unknown error'}`
  }
  if (result?.reason === 'empty-reply') return 'the model answered with no text'
  if (result?.reason === 'aborted') return 'the call was cut before it finished'
  if (result?.reason === 'nothing-to-fork') return 'no turn in this session yet — send a message first'
  return 'the call did not come back'
}

/**
 * The one model call the mod makes.
 *
 * `$.model.complete` is the natural spelling, and it is what this used: on a
 * machine whose provider answers a non-streaming `/v1/messages` with an
 * OpenAI-shaped body (`choices[0].message.content` as a string, no `content`
 * array), the engine's own `.flatMap` over that reply throws
 * (`undefined is not an object (evaluating 'e.flatMap')`) and takes the click's
 * `void` promise down with it, so nothing was ever reported and the draft never
 * changed. `$.model.fork` asks the same model over the engine's streaming path,
 * where that provider is correct, and resolves to a result instead of throwing.
 *
 * It takes only `{ prompt }` — no model, timeout or signal — and appends the
 * instruction to the conversation as the main thread last sent it. That last
 * part is checked: the fork adds no rows to the transcript, and it needs one
 * turn in the session before it can answer (`nothing-to-fork`).
 */
const ask = async ($: any, instruction: string): Promise<string | { why: string }> => {
  const result: any = await $.model.fork({ prompt: instruction })
  return result.isAnswered === true ? result.text : { why: why(result) }
}

/**
 * The project's own instructions, so a rewrite can use the project's language
 * rather than generic ones. A missing or unreadable file is not a failure: the
 * rewrite simply goes without it.
 */
const readProjectGuide = async ($: any): Promise<string> => {
  // A relative path resolves under the session's working directory.
  try {
    const text = await $.fs.read('CLAUDE.md')
    return typeof text === 'string' ? text.slice(0, MAX_CLAUDE_MD) : ''
  } catch {
    return ''
  }
}

const applyText = async ($: any, before: string, after: string) => {
  const filled = await $.prompt.fill({ text: after, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.status(`the prompt bar would not take it: ${filled.refusal ?? 'unknown refusal'}`)
    await update($, phase, () => ({ kind: 'failed', reason: 'the prompt bar refused the rewrite' }))
    return false
  }
  await update($, applied, () => ({ before, after }))
  await update($, phase, () => ({ kind: 'idle' }))
  return true
}

const revert = async ($: any) => {
  const last: Applied | null = await read($, applied)
  if (last === null) return
  const filled = await $.prompt.fill({ text: last.before, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.status(`the prompt bar would not take the revert: ${filled.refusal ?? 'unknown refusal'}`)
    return
  }
  await update($, applied, () => null)
}

const enhance = async ($: any) => {
  const box = await $.prompt.read()
  if (box.text.trim() === '') {
    $.ui.status('there is nothing in the prompt bar to enhance')
    return
  }
  await update($, phase, () => ({ kind: 'working' }))
  $.ui.status('rewriting the draft…')

  try {
    const installed = await read($, skills)
    const project = await read($, context)
    const answer = await ask($, buildEnhancePrompt(box.text, installed, project))

    if (typeof answer !== 'string') {
      const reason = `${answer.why}; the draft is unchanged`
      $.ui.status(reason)
      await update($, phase, () => ({ kind: 'failed', reason }))
      return
    }
    const parsed = parseEnhance(answer)
    if (parsed === null) {
      $.ui.status('the rewrite was not in the form asked for; the draft is unchanged')
      await update($, phase, () => ({ kind: 'failed', reason: 'the rewrite was not in the form asked for' }))
      return
    }
    $.ui.log(`skills ${JSON.stringify(parsed.skills)}`, { to: 'debug' })
    await applyText($, box.text, parsed.text)
  } catch (err) {
    // Nothing above may escape into the `void` a press runs under: an unhandled
    // rejection there is swallowed whole and the draft silently never changes.
    const detail = err instanceof Error ? err.message : String(err)
    $.ui.status(`enhancing failed: ${detail}`)
    $.ui.log(`enhancing threw: ${detail}`, { to: 'debug' })
    await update($, phase, () => ({ kind: 'failed', reason: detail }))
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-enhance',
      description: 'Enhance the prompt in the box.',
    })
    const home = await $.env.get('HOME')
    if (home !== undefined) {
      await update($, skills, () =>
        listSkillsWith(home, p => $.fs.list(p), p => $.fs.read(p)),
      )
    }
    // `update`'s writer is synchronous, so the read happens before the write.
    const claudeMd = await readProjectGuide($)
    await update($, context, () => ({ cwd: e.cwd, claudeMd }))
    return next(e)
  })

  on('command.run', { command: 'prompt-enhance' }, async $ => {
    await enhance($)
    return { text: 'Prompt enhanced.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    if (e.props.hasSurvey) return null
    const last: Applied | null = await read($, applied)
    const now: Phase = await read($, phase)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      // `gap` is what puts air between the label and the button; the band lays
      // these out in a row, so without it they run together as one string.
      <Box gap={2}>
        <Text dimColor>🪄 Prompt Enhancer</Text>
        {now.kind === 'working' ? (
          <Text color="warning">rewriting…</Text>
        ) : now.kind === 'failed' ? (
          <Text color="error">{now.reason}</Text>
        ) : null}
        {last === null ? (
          // Two ways in, deliberately. `hotkey` is the bare letter, and it reads
          // once the band holds the keyboard (ctrl+x tab, or a click on it) —
          // never the composer, so typing "enhance" is still typing.
          // `action` is the escape from that: bind `ctrl+e` to the action in
          // ~/.claude/keybindings.json and the chord presses this from the
          // prompt, which survives a terminal that eats the chord above.
          <Button
            key="enhance"
            label={boxed('Enhance')}
            plain
            hotkey="e"
            action={ENHANCE_ACTION}
            onPress={() => { void enhance($) }}
          />
        ) : (
          <Button
            key="revert"
            label={boxed('Revert')}
            plain
            hotkey="r"
            action={REVERT_ACTION}
            onPress={() => { void revert($) }}
          />
        )}
      </Box>
    )
  })
}
