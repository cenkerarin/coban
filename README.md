# coban

A terminal app (think [herdr](https://www.bitdoze.com/herdr-agent-multiplexer/)) where **one orchestrator agent
dispatches tasks to many other AI coding agents** — several Claude Code accounts, Codex, OpenCode, Cursor —
and those agents can **message each other**.

> Status: early (v0.1). Tested with a fake agent and a real Claude launch; a full multi-account run is still to be
> battle-tested. Issues and PRs welcome.

```
                  ╔═1═════════════════╗
                  ║    ORKESTRATÖR    ║
                  ║  ● Claude · H1    ║
                  ╚═════════╤═════════╝
   ┏━━━━━━━━━━━━━━━━━━━━━━━━╋━━━━━━━━━━━━━━━━━━━━━━━┓
╭─2─────────┸─────╮ ╭─3─────────┸──────────╮   ╭┄┄┄┸┄┄╮
│      ○ h2 ✓     │ │         ! h3         │   ┆  +   ┆
│ Claude H2·boşta │ │ Claude H3 · izin bek.│   ┆ işçi ┆
╰─────────────────╯ ╰──────────────────────╯   ╰┄┄┄┄┄┄╯
─ ● orkestra · Claude H1 · çalışıyor ─────────────────────
  (the focused agent's real terminal: Claude Code, Codex, …)
```

## How it works

- `coban` opens a TUI with an agent **graph** on top and the focused agent's terminal below. Click the `+` bubble
  (or press Enter) to pick the **orchestrator**'s profile; it starts with a system prompt that teaches it the
  `coban` CLI. Workers appear as bubbles wired to it — click one to switch the terminal to it.
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
  "orchestratorModel": "claude-sonnet-5-5",
  "profiles": [
    { "id": "h1", "title": "Claude H1", "cmd": "claude --allowedTools 'Bash(coban:*)'", "model": "claude-opus-5-5",
      "promptArg": "-- {prompt}", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-hesap1" }, "color": "#F6D5C8" },
    { "id": "h2", "title": "Claude H2", "cmd": "claude --allowedTools 'Bash(coban:*)'", "model": "claude-sonnet-5-5",
      "promptArg": "-- {prompt}", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-hesap2" } },
    { "id": "codex", "title": "Codex", "cmd": "codex", "promptArg": "{prompt}" }
  ]
}
```

`model` is appended as `--model <model>`. `orchestratorModel` overrides it for whichever profile you pick as
orchestrator — coordination is mostly reading and routing, so a cheaper model there saves the most.

## Keeping context small

Every CLI output lands in the calling agent's context and is re-read on each later request, so coban keeps it lean:
one-line outputs (`--json` for raw), `coban read` defaults to 20 lines with Claude Code/Codex UI chrome stripped
(`--raw` to keep it), and the prompts tell workers to send ≤5-line summaries and put long results in
`.coban/reports/<id>.md` (git-ignored automatically) instead of having the orchestrator read their screens.

## Keys

Mouse: click a bubble to focus it, click `+` to add an agent. Mouse events inside the terminal area are forwarded
when the agent asks for them.

`ctrl+b` then: `n` new agent · `1-9` select · `j`/`k` next/prev · `o` orchestrator (or pick one) · `u` next unread ·
`x` close agent · `q` quit · `ctrl+b` send a literal ctrl+b.

## Known gaps

No scrollback, no split view, no kitty keyboard protocol (shift+enter), no session restore. Codex's sandbox
may block the unix socket. Status detection is screen heuristics and may need tuning per CLI version. Because coban
captures the mouse, use your terminal's selection modifier (e.g. ⌥/Option-drag) to select text.

## License

MIT
