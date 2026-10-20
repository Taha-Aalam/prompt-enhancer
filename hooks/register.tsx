import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Applied, Phase, Skill } from '../types'
import type { Question } from './enhance'
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
 * what puts a chord on these buttons (the README has the file).
 *
 * Which context the binding goes in matters as much as the key. Both of these
 * live in the `Confirmation` context, and a `Confirmation` action bound under
 * `Global` does not fire: the chord is only ever looked up while a permission
 * dialog is up. They are listed as actions the keybindings file may name, which
 * is what makes them free to borrow — the file accepts them in any block, so one
 * more reason to put the `Global` entry in the file this mod's README points at.
 */
const ENHANCE_ACTION = 'confirm:previousField'
const REVERT_ACTION = 'permission:toggleDebug'

/**
 * The chord, as it is drawn beside a button: `Ctrl+E:`.
 *
 * The chord sits outside the button, not in its label. A button brackets
 * whatever its label says, so a chord named in the label lands inside the
 * brackets — `[ Ctrl+E  Enhance ]` — which reads as one control rather than a
 * key and the thing it presses. Drawn beside it, the band reads
 * `Ctrl+E: [ Enhance ]`: the key, a colon, then the button it presses.
 *
 * `plain` is not used for the same reason: it draws the `hotkey` prop before
 * the label, which put a bare `e:` there — a letter that does nothing from the
 * composer. The letter still rides on the button as `hotkey`, so the band keeps
 * working once it holds the keyboard; it is just not what the band advertises.
 */
const chord = (key: string) => `${key}:`

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
 * A fork is the first choice: it goes out over the engine's streaming path, where
 * providers are correct, it costs nothing to spell (it takes only `{ prompt }`
 * and uses whatever model the session is already on), and it adds no rows to the
 * transcript. Its one requirement is a turn to fork from — a fresh session, one
 * right after a `/clear`, or a resume that starts the conversation afresh has
 * none, and it answers `nothing-to-fork` rather than making a request.
 *
 * That is the first press in every new session, so a refusal there falls back to
 * a completion: `$.model.complete` asks a model outright and needs no history.
 * The fallback names a model (the session's own, via `$.session.model()`) and
 * reads the reply whole, over the non-streaming path — the one shape some
 * providers get wrong, which is why it is second and not first.
 */
const ask = async ($: any, instruction: string): Promise<string | { why: string }> => {
  const forked: any = await $.model.fork({ prompt: instruction })
  if (forked.isAnswered === true) return forked.text
  if (forked.reason !== 'nothing-to-fork') return { why: why(forked) }

  const done: any = await $.model.complete({
    model: await $.session.model(),
    prompt: instruction,
    maxTokens: 8_000,
  })
  return done.isAnswered === true ? done.text : { why: why(done) }
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

/** How many questions are worth asking before the rewrite is written. */
const MAX_QUESTIONS = 2

/**
 * Asks the model for a rewrite, then for a second one that folds in whatever
 * the person answered.
 *
 * The questions come back on the first pass, and they are asked *before* the
 * rewrite is put in the prompt bar, so the answer shapes the rewrite rather
 * than arriving after it. A draft with nothing worth asking gets one pass and
 * no dialog, which is most of them.
 *
 * `$.ui.ask` is the engine's own question dialog: it takes the keyboard itself,
 * unlike a `Select` in the band, which only reads while the band already holds
 * focus. It rejects when dismissed and in a `-p` run where nobody can answer,
 * so a refusal means "carry on with what we have", not "fail".
 */
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
    const first = await ask($, buildEnhancePrompt(box.text, installed, project))

    if (typeof first !== 'string') {
      const reason = `${first.why}; the draft is unchanged`
      $.ui.status(reason)
      await update($, phase, () => ({ kind: 'failed', reason }))
      return
    }
    const parsed = parseEnhance(first)
    if (parsed === null) {
      $.ui.status('the rewrite was not in the form asked for; the draft is unchanged')
      await update($, phase, () => ({ kind: 'failed', reason: 'the rewrite was not in the form asked for' }))
      return
    }
    $.ui.log(`skills ${JSON.stringify(parsed.skills)}`, { to: 'debug' })

    let text = parsed.text
    const answers = await collect($, parsed.questions.slice(0, MAX_QUESTIONS))
    if (answers.length > 0) {
      $.ui.status('rewriting with your answers…')
      const second = await ask($, buildEnhancePrompt(box.text, installed, project, answers))
      // A failed or malformed second pass is not a failed enhance: the first
      // rewrite is already good, and it is better to land it than to lose it.
      if (typeof second === 'string') {
        const again = parseEnhance(second)
        if (again !== null) text = again.text
      }
    }

    await applyText($, box.text, text)
  } catch (err) {
    // Nothing above may escape into the `void` a press runs under: an unhandled
    // rejection there is swallowed whole and the draft silently never changes.
    const detail = err instanceof Error ? err.message : String(err)
    $.ui.status(`enhancing failed: ${detail}`)
    $.ui.log(`enhancing threw: ${detail}`, { to: 'debug' })
    await update($, phase, () => ({ kind: 'failed', reason: detail }))
  }
}

/**
 * Puts each question to the person and keeps the answers.
 *
 * At most `MAX_QUESTIONS` are put, however many the model asked: a rewrite is
 * worth two questions, not an interrogation.
 *
 * A dismissed dialog ends the asking rather than the enhance: whatever was
 * answered so far still shapes the rewrite, and the rest is left as it was.
 *
 * Exported so a test can drive it directly. `$.ui.ask` is not an event — it
 * runs the engine's own AskUserQuestion tool — so it cannot be stood in for
 * with `on(...)` the way the other engine calls are; the test hands in a `$`
 * whose `ui.ask` it owns.
 */
export const collect = async (
  $: any,
  questions: Question[],
): Promise<{ question: string; answer: string }[]> => {
  const answers: { question: string; answer: string }[] = []
  for (const q of questions.slice(0, MAX_QUESTIONS)) {
    try {
      const answer = await $.ui.ask(q.question, q.options)
      if (typeof answer === 'string' && answer.trim() !== '') {
        answers.push({ question: q.question, answer: answer.trim() })
      }
    } catch {
      // Dismissed, or no one to ask. Stop here; the answers so far still count.
      break
    }
  }
  return answers
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const last: Applied | null = await read($, applied)
    const now: Phase = await read($, phase)
    const { Box, Text, Button } = $.ui.resolve(e)

    // `AbovePrompt` is one site shared by every mod: answering it without `next`
    // takes the whole site, and the mods beneath — skins' usage band, another
    // mod's progress — never draw. This hook used to do exactly that, which is
    // why the band below the prompt went missing whenever this mod was loaded.
    const drawn = await next(e).catch(() => null)
    // Claude Code's own placeholder is never nested: a surface drops a band that
    // nests it, so the placeholder is left out and only the mods' drawings kept.
    const below =
      drawn !== null && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine'
        ? drawn
        : null

    const row = (
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
          // Two ways in, deliberately, and the chord named beside it is the one
          // that works from anywhere. `action` is that chord: bind it in
          // ~/.claude/keybindings.json and it presses this from the prompt, with
          // no focus to move first, which survives a terminal that eats the
          // `ctrl+x` prefix. `hotkey` is the bare letter, and it reads only once
          // the band holds the keyboard (ctrl+x tab, or a click on it) — never
          // the composer, so typing "enhance" is still typing.
          <Box gap={1}>
            <Text dimColor>{chord('Ctrl+E')}</Text>
            <Button
              key="enhance"
              label="Enhance"
              hotkey="e"
              action={ENHANCE_ACTION}
              onPress={() => { void enhance($) }}
            />
          </Box>
        ) : (
          <Box gap={1}>
            <Text dimColor>{chord('Ctrl+U')}</Text>
            <Button
              key="revert"
              label="Revert"
              hotkey="r"
              action={REVERT_ACTION}
              onPress={() => { void revert($) }}
            />
          </Box>
        )}
      </Box>
    )

    return below === null ? row : (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
