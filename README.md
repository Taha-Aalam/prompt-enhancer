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

  1. `/enhance` rewrites the rough prompt sitting in your composer.
  2. Review the rewrite, edit it if you want, then send it.

## How it works

`.claude-plugin/plugin.json` declares the plugin and points at its hooks module.
`hooks/hooks.json` names `register.tsx`, which exports `register` — a set of hooks that run
alongside Claude Code's own. A hook that returns without calling `next` answers for itself;
one that returns `next(e)` lets the engine carry on.

Anything the mod keeps between events lives in `$.state`, and every key it uses is declared in
`types/index.d.ts` so `claude plugin validate` can check them.

## Limits worth knowing

- It reads `~/.claude/skills` off disk to name installed skills, because no API lists them.

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
