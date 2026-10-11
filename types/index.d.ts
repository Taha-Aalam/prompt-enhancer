export type Skill = {
  name: string
  description: string
}

export type Applied = {
  before: string
  after: string
}

/** What the mod is doing, and why it stopped. */
export type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  /** A failure, in words fit to show the person. */
  | { kind: 'failed'; reason: string }

/** The project a rewrite is written for. */
export type Context = {
  cwd: string
  claudeMd: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': {
      applied: Applied | null
      skills: Skill[]
      phase: Phase
      context: Context
    }
  }
}