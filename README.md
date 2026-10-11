# Prompt Enhancer

Rewrites a rough prompt into a structured one before you send it.

A [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins).

## Install

At the prompt of a Claude Code session, run:

```
/plugin install prompt-enhancer --marketplace Taha-Aalam/prompt-enhancer
```

Answer `y` to add the marketplace, then choose the user scope.

## Use

The band above your prompt carries the control. Click **Enhance**, or reach the band
(ctrl+x tab, or a click on it) and press `e`, to rewrite the rough prompt sitting in your
composer. Once a rewrite is in the box the button becomes **Revert** (`r`), which puts your
original draft back.

You can also run `/prompt-enhance` from anywhere.

Either way the rewrite lands **in the composer, not in the conversation**. Read it, edit it,
and send it yourself — nothing is submitted without you.

## What the rewrite knows

It is given your draft, the skills installed on this machine, and the project you are in —
its working directory and the project's own `CLAUDE.md` — so it can suggest the skills that
actually fit and speak in the project's terms. It returns the rewritten prompt, the skills
worth loading, any choices worth asking about first, and what "done" looks like.

## How it works

`.claude-plugin/plugin.json` declares the plugin and points at its hooks module.
`hooks/hooks.json` names `register.tsx`, which exports `register` — a set of hooks that run
alongside Claude Code's own. A hook that returns without calling `next` answers for itself;
one that returns `next(e)` lets the engine carry on.

Anything the mod keeps between events lives in `$.state`, and every key it uses is declared in
`types/index.d.ts` so `claude plugin validate` can check them.

The model call is `$.model.fork`, not `$.model.complete`. Against a provider whose
non-streaming `/v1/messages` reply is not Anthropic-shaped, `complete` throws inside the engine
and, under a button press, took the whole attempt silently. `fork` goes out over the streaming
path, where such providers are correct, and resolves to a result the mod can report. The cost
is that a fork needs one turn in the session: on a brand-new session the first Enhance says so
rather than failing quietly.

## Limits worth knowing

- It reads `~/.claude/skills` off disk to name installed skills, because no API lists them.
- `e` and `r` are read by the band, not the composer, so they need the band's focus
  (ctrl+x tab or a click on it). They are deliberately not bound globally — that would take
  those letters away from everything you type.
- A failed rewrite leaves your draft exactly as it was and says why, in the band.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

The tests run through the plugin engine's own test harness: they load this module, stand in for the
events it hooks, and assert on what it drew and returned. That proves the module loads, that its
hooks fire, and that its trees and answers are shaped correctly. It is not the same as a live
session — anything that reaches the model, the network or the filesystem has to be tried in one.
