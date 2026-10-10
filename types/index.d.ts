export type Skill = {
  name: string
  description: string
}

export type Applied = {
  before: string
  after: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': {
      applied: Applied | null
      skills: Skill[]
    }
  }
}