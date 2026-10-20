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

The band above your prompt carries the control: `🪄 Prompt Enhancer   [ Ctrl+E  Enhance ]`.

Click it to rewrite the rough prompt in your composer. Once a rewrite is in the box the button
becomes `[ Ctrl+U  Revert ]`, which puts your original draft back.

You can also run `/prompt-enhance` from anywhere.

Either way the rewrite lands **in the composer, not in the conversation**. Read it, edit it,
and send it yourself — nothing is submitted without you.

## Keyboard

**`Ctrl+E`** rewrites and **`Ctrl+U`** reverts, from the composer, with no focus to move first.
Both are single keystrokes, so they work the same in every terminal and multiplexer.

To turn them on, put this in `~/.claude/keybindings.json` (create it by running `/keybindings`):

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "$docs": "https://code.claude.com/docs/en/keybindings",
  "bindings": [
    {
      "context": "Global",
      "bindings": {
        "ctrl+e": "confirm:previousField",
        "ctrl+u": "permission:toggleDebug"
      }
    }
  ]
}
```

Changes apply immediately — no restart. The two action names look odd, and that is the point:
they are the ones Claude Code documents as actions it *does not respond to*, so they are free for
a button to borrow and no built-in feature can take the chord away later. Keep the `Global` block
as it is written — that is the only context where these chords fire. Change the keys freely;
only the two actions must stay.

**`e`** and **`r`** also work, but only once the band holds the keyboard — press `ctrl+x` `tab`
(within 3 seconds of each other), or click the band, then press the letter. That route is why
`Ctrl+E` is what the button advertises: a terminal that eats the `ctrl+x` prefix also eats
`e`, but it has no reason to eat `Ctrl+E`.

Either way `esc` returns focus to the composer.

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

The model call is `$.model.fork` first, and `$.model.complete` behind it. A fork goes out over
the engine's streaming path, where providers are correct, and costs nothing to spell — but it
needs one turn in the session to fork from, which a brand-new session, one just after a
`/clear`, and a fresh resume have not got. A completion asks a model outright and needs no
history, so that is where those go. The order matters: against a provider whose non-streaming
`/v1/messages` reply is not Anthropic-shaped, `complete` throws inside the engine, so it is
never the first thing tried.

## Limits worth knowing

- It reads `~/.claude/skills` off disk to name installed skills, because no API lists them.
- `e` and `r` are read by the band, not the composer, so on their own they need the band's
  focus (ctrl+x tab, or a click on it). They are deliberately not bound globally — that would
  take those letters away from everything you type. The `ctrl+e` / `ctrl+u` bindings above are
  the chord route, and they leave typing alone.
- A chord only fires while no dialog is up and nothing else has claimed the action. If
  `ctrl+e` stops working, check that no other plugin has bound it too, and that the binding is
  in a `Global` block — a `Confirmation` action bound elsewhere never fires.
- `Ctrl+U` rather than `Ctrl+R` for Revert, because `Ctrl+R` is history search in every
  context and rebinding it costs you that.
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
