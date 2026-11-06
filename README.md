# coban

A terminal app (think [herdr](https://www.bitdoze.com/herdr-agent-multiplexer/)) where **one orchestrator agent
dispatches tasks to many other AI coding agents** — several Claude Code accounts, Codex, OpenCode, Cursor —
and those agents can **message each other**.

> Status: early (v0.1). Tested with a fake agent and a real Claude launch; a full multi-account run is still to be
> battle-tested. Issues and PRs welcome.

```
 coban                          │
                                │   (the focused agent's real terminal)
▌● 1 ★ orkestra                 │
     Claude H1   çalışıyor      │
 ! 2 h2                         │
     Claude H2   izin bekliyor  │
 ○ 3 codex                     ✓│
     Codex       boşta          │
 ─ mesajlar ───────────────     │
 h2→orkestra                    │
  API şemasını değiştirdim      │
```

## How it works

- `coban` opens a TUI and starts the **orchestrator** (default: profile `h1`) with a system prompt that teaches it
  the `coban` CLI.
- Every agent runs in its own PTY; coban emulates its screen (xterm) and infers a status from it:
  `working`, `blocked` (waiting for a permission), `limited` (usage limit), `idle`, `exited`.
- Agents coordinate through the **`coban` CLI over a unix socket** — no MCP server needed. Anything that can run a
  shell command can take part.

```
coban agents                                   list agents + status
coban spawn <profile> "<task>" [--name x] [--cwd dir]
coban post <id|user> "<message>"               (alias: send) queued until the target is idle
coban wait [id...] [--timeout s]               returns when an agent settles or mail arrives
coban read <id> [--lines n] [--scrollback]     read an agent's screen
coban key <id> <keys...>                       enter esc up down tab y 1 2 ...
coban kill <id> · coban inbox · coban log
```

## Install

Requires Node ≥ 24 (runs TypeScript directly, no build step) and macOS/Linux.

```sh
git clone https://github.com/cenkerarin/coban && cd coban
npm install
ln -s "$PWD/bin/coban" ~/.local/bin/coban
coban            # run inside the project you want the agents to work on
```

## Config

`~/.config/coban/config.json` is created on first run. Each profile is a command plus env vars, so multiple
accounts are just different `CLAUDE_CONFIG_DIR`s:

```json
{
  "orchestrator": "h1",
  "profiles": [
    { "id": "h1", "title": "Claude H1", "cmd": "claude --model claude-opus-5-5 --allowedTools 'Bash(coban:*)'",
      "promptArg": "-- {prompt}", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-hesap1" }, "color": "#F6D5C8" },
    { "id": "codex", "title": "Codex", "cmd": "codex", "promptArg": "{prompt}" }
  ]
}
```

## Keys

`ctrl+b` then: `n` new agent · `1-9` select · `j`/`k` next/prev · `o` orchestrator · `u` next unread ·
`x` close agent · `q` quit · `ctrl+b` send a literal ctrl+b.

## Known gaps

No mouse/scrollback, no split view, no kitty keyboard protocol (shift+enter), no session restore. Codex's sandbox
may block the unix socket. Status detection is screen heuristics and may need tuning per CLI version.

## License

MIT
