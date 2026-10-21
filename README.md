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

The band above your prompt appears **once you have written something in it**, and goes when the
box is empty again. With nothing typed there is nothing to enhance and nothing to send, so the
row is not there through a turn that has nothing to do with it.

It carries both halves of the choice: `🪄 Prompt Enhancer   Ctrl+E: [ Enhance ]   [ Send ]`.

**Enhance** rewrites the rough prompt in your composer. **Send** submits it exactly as you typed
it — the same thing Enter does, for when the band is what has the keyboard. Once a rewrite is in
the box the first button becomes `Ctrl+U: [ Revert ]`, which puts your original draft back.
Revert is offered only for the rewrite that is in the box: edit or empty it, and the draft is
yours again, with nothing to revert.

The band is one site every mod draws into, so this one adds its row above whatever the mods
beneath it draw — skins' usage band, another mod's progress — rather than taking the site. With
an empty box it adds nothing and leaves them their band.

If the draft leaves something out that would change the answer, the model asks **at most two**
questions before writing — a real dialog with options, using Claude Code's own question UI. Your
answers are folded into the rewrite rather than asked after it. A draft with nothing worth asking
gets no dialog at all, which is most of them.

You can also run `/prompt-enhance` from anywhere.

Either way the rewrite lands **in the composer, not in the conversation**. Read it, edit it,
and send it yourself — nothing is submitted without you. The one thing that does submit is
**Send**, and only because you pressed it.

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

**`e`**, **`r`** and **`s`** also work, but only once the band holds the keyboard — press `ctrl+x`
`tab` (within 3 seconds of each other), or click the band, then press the letter. That route is
why `Ctrl+E` is what the button advertises: a terminal that eats the `ctrl+x` prefix also eats
`e`, but it has no reason to eat `Ctrl+E`. `s` sends; it carries no chord of its own, because
Enter already does exactly that from the composer.

Either way `esc` returns focus to the composer.

## What the rewrite knows

It is given your draft, the skills installed on this machine, and the project you are in —
its working directory and the project's own `CLAUDE.md` — so it can suggest the skills that
actually fit and speak in the project's terms.

The rules make it **diagnose before it rewrites**: find what the draft leaves out — who it is
for, what the output should be, what done looks like — and put a guess in a question rather than
in the rewrite, because a guess written into a prompt becomes a false requirement. It matches the
shape of the rewrite to the kind of task (code and debugging, writing and design, research and
explanation, planning), and it names a role only where the task needs one.

It returns the rewritten prompt, the skills worth loading, up to two questions with their
options, and what "done" looks like. The questions are asked; the skills and the definition of
done are logged to the debug log, not shown.

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
- Revert uses `Ctrl+U` rather than `Ctrl+R` because `Ctrl+R` is history search in every context
  by default; taking it would cost you that. `Ctrl+U` is unbound, so it costs nothing.
- A failed rewrite leaves your draft exactly as it was and says why, in the band.
- A rewrite still in flight is dropped if the draft it was written for has left the box — you
  edited it, emptied it or sent it while the model was thinking. What you did stays.
- Send empties the box before it submits, and puts the draft back if the submission is refused
  or throws. A prompt sent while a turn is running is queued, and text left in the box through
  all of that invites a second send.

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
