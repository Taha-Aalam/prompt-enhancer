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

/**
 * Whether the prompt box held a draft at the last change to it; `null`, nobody
 * has looked yet.
 *
 * The row is drawn only while the box holds a draft, and the band's props do
 * not change as the person types, so nothing would redraw it when the box goes
 * from empty to written or back. The band reads this value while it draws,
 * which subscribes that drawing to it, so writing it here is what redraws the
 * row at exactly those two moments — and nothing else is redrawn with it, where
 * `$.ui.invalidate` would redraw every site in the session on every first
 * keystroke.
 *
 * It is state, not a module variable, because it is a fact about this session's
 * box: a hot reload starts the module's variables over while the box stays as
 * the person left it.
 */
const draft = atom({ plugin: 'prompt-enhancer', key: 'draft' } as const, null as boolean | null)

/** Puts the row back to rest: no rewrite left to revert, nothing left failed. */
const rest = async ($: any) => {
  if ((await read($, applied)) !== null) await update($, applied, () => null)
  if ((await read($, phase)).kind === 'failed') await update($, phase, () => ({ kind: 'idle' }))
}

/**
 * Records a failure in the row — unless the draft it was about has left the box.
 *
 * A rewrite outlives the draft that asked for it: the person can empty the box
 * while the model works, and the failure then lands in a row that is not drawn.
 * Held, it would greet the next draft they write with a complaint about the one
 * before it, so a failure that has nothing left to describe is dropped.
 */
const fail = async ($: any, reason: string) => {
  const box = await $.prompt.read()
  await update($, phase, () =>
    box.text.trim() === '' ? { kind: 'idle' } : { kind: 'failed', reason },
  )
}

/**
 * Follows the box after every change to it.
 *
 * The row exists for a draft, so the two moments the box goes empty or stops
 * being empty are the only ones that change what it shows; a keystroke that
 * leaves the box still written changes nothing, and redrawing for it would
 * redraw the row, and every other mod's band beneath it, for nothing.
 *
 * The write is what redraws the row: the band reads the value while it draws,
 * so a write reaches it. The invalidate is the belt to that braces — a redraw
 * asked for on the two moments a draft starts and stops, which is nothing next
 * to a redraw on every keystroke, and which stands in case the reading that
 * subscribes the band did not happen on the pass-through path the empty box
 * takes.
 *
 * A draft that has left the box takes the row's state with it: there is no
 * rewrite left to revert, and a failure was said about a draft that is gone.
 */
const follow = async ($: any, text: string) => {
  const isDraft = text.trim() !== ''
  if (isDraft === (await read($, draft))) return
  await update($, draft, () => isDraft)
  $.ui.invalidate('ui.render')
  if (!isDraft) await rest($)
}

/**
 * Sends the draft as it stands, as the person's own words.
 *
 * The box is emptied first and the text sent second. A prompt submitted while a
 * turn runs is queued and may not enter until that turn ends, so text left in
 * the box through all of it invites a second send; emptied first, the row goes
 * with the draft it was drawn for. Nothing is lost to a refusal: a submission
 * the engine drops, or a call that throws, puts the draft back where it was,
 * with the reason in the row.
 *
 * `asUser` is what pressing Send means. Without it the model reads the prompt
 * under the mod's name — "The prompt-enhancer plugin sent a message" — which is
 * the right frame for a mod's own words and the wrong one for the words the
 * person typed and chose to send unchanged.
 */
const send = async ($: any) => {
  const box = await $.prompt.read()
  const text = box.text
  if (text.trim() === '') return
  const last: Applied | null = await read($, applied)

  const cleared = await $.prompt.fill({ text: '', mode: 'replace' })
  if (!cleared.isFilled) {
    $.ui.status(`the prompt bar would not clear: ${cleared.refusal ?? 'unknown refusal'}`)
    return
  }

  const restore = async (reason: string) => {
    const back = await $.prompt.fill({ text, mode: 'replace' })
    if (back.isFilled && last !== null) await update($, applied, () => last)
    $.ui.status(reason)
    await fail($, reason)
  }

  try {
    const result: any = await $.prompt.submit({ text, asUser: true })
    if (typeof result?.drop === 'string') {
      await restore(`the prompt was not sent: ${result.drop}`)
      return
    }
    await rest($)
  } catch (err) {
    // A throw here would vanish into the `void` the press runs under.
    const detail = err instanceof Error ? err.message : String(err)
    $.ui.log(`sending threw: ${detail}`, { to: 'debug' })
    await restore(`sending failed: ${detail}`)
  }
}

const applyText = async ($: any, before: string, after: string) => {
  const filled = await $.prompt.fill({ text: after, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.status(`the prompt bar would not take it: ${filled.refusal ?? 'unknown refusal'}`)
    await fail($, 'the prompt bar refused the rewrite')
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
      await fail($, reason)
      return
    }
    const parsed = parseEnhance(first)
    if (parsed === null) {
      $.ui.status('the rewrite was not in the form asked for; the draft is unchanged')
      await fail($, 'the rewrite was not in the form asked for')
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

    // The box is the person's while the model works. A rewrite is put in only
    // where the draft it was written for is still the one in the box: emptying
    // it, editing it or sending it means they moved on, and landing the rewrite
    // over what they did instead would undo them.
    const now = await $.prompt.read()
    if (now.text !== box.text) {
      $.ui.status('the draft changed while it was being rewritten; the rewrite was dropped')
      await update($, phase, () => ({ kind: 'idle' }))
      return
    }
    await applyText($, box.text, text)
  } catch (err) {
    // Nothing above may escape into the `void` a press runs under: an unhandled
    // rejection there is swallowed whole and the draft silently never changes.
    const detail = err instanceof Error ? err.message : String(err)
    $.ui.status(`enhancing failed: ${detail}`)
    $.ui.log(`enhancing threw: ${detail}`, { to: 'debug' })
    await fail($, detail)
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

  // Every way the box changes is one of these two: an edit (a key, a paste, an
  // undo), which resolves the box the editor shows, and everything else — a
  // recalled history entry, a clear, a fill, a submit taking the draft.
  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    await follow($, result.text)
    return result
  })

  on('prompt.change', async ($, e, next) => {
    const result = await next(e)
    await follow($, result.text)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    // Read before the box is, and before any return: the read is what subscribes
    // this drawing to the value, and a drawing that has already returned is one
    // `follow` cannot redraw. An empty box is exactly the drawing that has to be
    // redrawn when the person types, so this is the one read that must happen
    // however the row turns out.
    await read($, draft)

    // The row exists for a draft and for nothing else: with the box empty there
    // is nothing to enhance and nothing to send, and a band that sat there
    // through every turn was one more line of chrome above a prompt it had no
    // business describing. The box is read as it stands rather than remembered,
    // so the row is right on the first draw of a session that starts with a
    // draft already in it.
    const box = await $.prompt.read()
    if (box.text.trim() === '') return next(e)

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
        {/* The other half of the choice: send the draft exactly as typed. It is
            the same thing Enter does, so it carries no chord — every free one is
            already spent, and a chord that only works here would be a second way
            to do what the composer's own key does. Its letter reads once the
            band holds the keyboard, like the others. */}
        <Button
          key="send"
          label="Send"
          hotkey="s"
          onPress={() => { void send($) }}
        />
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
