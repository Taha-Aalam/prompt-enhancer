import type { Skill } from '../types'

export type Enhanced = {
  text: string
  skills: string[]
  questions: string[]
  result: string
}

export const buildEnhancePrompt = (draft: string, skills: Skill[]): string => {
  const catalogue =
    skills.length === 0
      ? '(none are installed)'
      : skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
  return [
    'Rewrite the user\'s rough prompt into a clearer one.',
    '',
    'Their prompt:',
    draft,
    '',
    'Skills installed on this machine:',
    catalogue,
    '',
    'Name only skills from that list, and only where they genuinely apply.',
    'Ask only for choices that would change the work substantially.',
    '',
    'Answer with one JSON object and nothing else:',
    '{"skills": string[], "questions": string[], "result": string, "text": string}',
  ].join('\n')
}

export const parseEnhance = (text: string): Enhanced | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const list = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string') : []
  const str = (x: unknown): string => (typeof x === 'string' ? x : '')
  if (str(v.text) === '') return null
  return { text: str(v.text), skills: list(v.skills), questions: list(v.questions), result: str(v.result) }
}