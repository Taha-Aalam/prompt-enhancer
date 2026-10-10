import type { Skill } from '../types'

const MAX_DESCRIPTION = 300

export const frontmatter = (text: string, key: string): string | undefined => {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('---', 3)
  if (end === -1) return undefined
  const line = text.slice(3, end).split('\n').find(l => l.trimStart().startsWith(`${key}:`))
  if (line === undefined) return undefined
  return line.slice(line.indexOf(':') + 1).trim()
}

export const listSkillsWith = async (
  home: string,
  list: (path: string) => Promise<any[]>,
  read: (path: string) => Promise<string>,
): Promise<Skill[]> => {
  let entries: Array<{ name: string; kind: string }>
  try {
    entries = await list(`${home}/.claude/skills`)
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    let text: string
    try {
      text = await read(`${home}/.claude/skills/${entry.name}/SKILL.md`)
    } catch {
      continue
    }
    const name = frontmatter(text, 'name')
    if (name === undefined) continue
    const description = frontmatter(text, 'description') ?? ''
    skills.push({ name, description: description.slice(0, MAX_DESCRIPTION) })
  }
  return skills
}