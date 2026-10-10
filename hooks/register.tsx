import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Applied, Skill } from '../types'
import { buildEnhancePrompt, parseEnhance } from './enhance'
import { listSkillsWith } from './skills'

const applied = atom({ plugin: 'prompt-enhancer', key: 'applied' } as const, null)
const skills = atom({ plugin: 'prompt-enhancer', key: 'skills' } as const, [] as Skill[])

const applyText = async ($: any, before: string, after: string) => {
  const filled = await $.prompt.fill({ text: after, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.status(`prompt-enhancer: box would not take it (${filled.refusal ?? 'unknown'})`)
    return
  }
  await update($, applied, () => ({ before, after }))
}

const revert = async ($: any) => {
  const last: Applied | null = await read($, applied)
  if (last === null) return
  const filled = await $.prompt.fill({ text: last.before, mode: 'replace' })
  if (!filled.isFilled) {
    $.ui.status(`prompt-enhancer: box would not take the revert (${filled.refusal ?? 'unknown'})`)
    return
  }
  await update($, applied, () => null)
}

const applyEnhancement = async ($: any) => {
  const box = await $.prompt.read()
  if (box.text.trim() === '') return
  $.ui.status('prompt-enhancer: enhancing')
  const installed = await read($, skills)
  const completion = await $.model.complete({
    model: 'haiku',
    prompt: buildEnhancePrompt(box.text, installed),
    system: 'You rewrite prompts. You answer with JSON only.',
    // A stalled provider must not hold the composer open; this resolves `aborted`.
    timeoutMs: 15_000,
  })
  if (!completion.isAnswered) {
    $.ui.status('prompt-enhancer: the rewrite did not come back, draft left alone')
    return
  }
  const parsed = parseEnhance(completion.text)
  if (parsed === null) {
    $.ui.status('prompt-enhancer: could not read the rewrite, draft left alone')
    return
  }
  $.ui.log(`prompt-enhancer: skills ${JSON.stringify(parsed.skills)}`, { to: 'debug' })
  await applyText($, box.text, parsed.text)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prompt-enhance', description: 'Enhance the prompt in the box.' })
    const home = await $.env.get('HOME')
    if (home !== undefined) {
      await update($, skills, () => listSkillsWith(home, p => $.fs.list(p), p => $.fs.read(p)))
    }
    return next(e)
  })

  on('command.run', { command: 'prompt-enhance' }, async $ => {
    await applyEnhancement($)
    return { text: 'Prompt enhanced.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    if (e.props.hasSurvey) return null
    const last: Applied | null = await read($, applied)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>Prompt Enhancer</Text>
        {last === null ? (
          <Button key="enhance" label="Enhance" onPress={() => { void applyEnhancement($) }} />
        ) : (
          <Button key="revert" label="Revert" onPress={() => { void revert($) }} />
        )}
      </Box>
    )
  })
}