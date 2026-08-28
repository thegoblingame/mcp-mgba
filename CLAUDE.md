# mcp-mgba

A **fork** of a public MCP server that bridges Claude to the mGBA emulator over a TCP
bridge, plus `src/fe7.ts` — the Fire Emblem 7 tool layer we wrote on top of it.

**This repo is the machinery. The game knowledge lives in `~/Desktop/repos/llm_plays_fe7`.**
Do not duplicate facts from there into here; they go stale in one place and not the other.

**Never read `llm_plays_fe7/misc/`.** It is Grant's scratch space — notes he may want to
copy-paste later, deliberately not for you. That rule lives in the other repo's `CLAUDE.md`,
which does not load when a session starts here, so it is restated where it will be seen.

## Where to look things up

| If you are… | Read |
|---|---|
| About to play the game | `llm_plays_fe7/RUNBOOK.md` |
| Looking for an address, struct, or formula | `llm_plays_fe7/RAM.md` — canonical, never guess |
| Deciding what to work on | `llm_plays_fe7/BACKLOG.md` |
| Confused about how the two repos relate | `llm_plays_fe7/README.md` |
| Investigating something in RAM | Spawn the `memory-investigator` agent |

## Priorities when playing

**Information gathering beats winning, and it is not close.** On a genuine conflict, take the
information without deliberating — if learning something might get a unit killed or lose the
chapter, do it anyway. Deaths, softlocks, corrupted saves and lost chapters are all fine;
Grant keeps a complete backup. Never ask permission before a risky or destructive experiment.

Read state from memory, never from screenshots. `RUNBOOK.md` has the rest.

## After editing any `src/*.ts`

Run `npm run build` **and restart Claude Code.**

The MCP server is a subprocess Claude Code spawns at session start, so a running session
keeps using the old `dist/`. Your change will appear to do nothing, with no error. This is
the single most time-wasting gotcha in the project.

## Do not edit `lua/bridge.lua`

Two reasons, and the second is architectural:

1. It needs mGBA restarted to reload — the old script holds TCP port 8765, so a second copy
   fails to bind.
2. **Its handlers run inside mGBA's frame callback.** A handler that waited for frames would
   stop frames advancing: instant deadlock. This is why all orchestration lives in
   TypeScript — Node is a separate process and can press a button, poll memory, and press
   again. Never move waiting logic into Lua.

## Testing tool changes without restarting

You cannot call a newly written tool through MCP in the same session. You *can* drive the
built module against the live bridge directly:

```js
import { MgbaClient } from "<repo>/dist/mgba.js";
import { handleFe7 } from "<repo>/dist/fe7.js";
const m = new MgbaClient("127.0.0.1", 8765);
console.log(await handleFe7("fe7_state", { brief: true }, m));
```

Use it. Three real bugs were caught this way that would otherwise have shipped, including
one that silently cost a unit its turn. Save a state first (`save_state` to an explicit
*path*, not a slot) so a bad test is recoverable.

## Conventions for `fe7.ts`

- **Confirm by effect, never by absence of change.** Read back the thing that should have
  changed. A press that "didn't error" proves nothing.
- **Report raw facts alongside interpretations.** A tool that confidently says "unoccupied"
  is worse than one reporting cost and occupancy separately — the confident version encodes
  a wrong claim and hides it.
- **Failure messages name the specific cause**, and distinguish causes the caller can act on.
  "It didn't work" wastes a turn; "occupied by a green NPC at (10,1)" does not.
- **Never hardcode a menu address.** Menus are allocated dynamically and stale copies survive
  at old addresses, looking perfectly plausible. Locate them by behaviour and verify.
- **Derive menu indices; do not scan for them.** Scanning means pressing A on entries you
  cannot identify in advance. That committed Wait once and cost a unit its turn.
- **Long-running tools must be resumable.** Any call that can exceed ~110s gets split into a
  short starter and a resumable waiter, as `fe7_end_turn` / `fe7_wait` are.

## It is a fork

`lua/bridge.lua` and `src/tools.ts` came from upstream; `src/fe7.ts` is entirely ours. Keep
that in mind when changing the first two — the fork can still take upstream changes.
