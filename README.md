# coban

[![ci](https://github.com/cenkerarin/coban/actions/workflows/ci.yml/badge.svg)](https://github.com/cenkerarin/coban/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**One orchestrator agent splits your request and hands the pieces to many AI coding agents** — several Claude Code
accounts, Codex, OpenCode, Cursor — while they message each other over direct messages and a shared board. You watch
and steer it all from one terminal screen.

```sh
npm install -g coban      # Node >= 24, macOS or Linux
cd ~/your-project && coban
```

![coban: conversation feed, agent graph and chat](docs/screenshot.svg)

<sub>Rendered by `npm run snapshot` with scripted demo agents. Left: who said what to whom. Middle: the orchestrator
and its workers — the dots on the edges are messages in flight. Right: the focused agent's real terminal.</sub>

## Why

- **Use all your accounts.** Hit a usage limit on one Claude account and coban hands the task to the least-spent one.
- **Parallel work without chaos.** Workers get small, scoped tasks with the exact code they need inlined, and tell
  each other about interface changes on the board.
- **You stay in control.** Permission questions from every agent land in one place and you answer them in a keystroke.
- **Plain tools.** Agents are the real CLIs in real terminals. No new agent runtime, no MCP server.

*Çoban* is Turkish for shepherd. The UI labels and the prompts coban gives agents are in Turkish for now.

## A session in four steps

1. **Start** `coban` in your project and pick the orchestrator with the `+` bubble (it defaults to your first profile).
2. **Ask** in the chat, e.g. *"add a login endpoint and a login form, with tests"*.
3. **Watch** the orchestrator run `coban map`, spawn workers (`api`, `istemci`, `test`), and give each its task and code.
   Workers post decisions to the board and message each other; packets travel along the graph edges.
4. **Answer** permission questions when a worker turns `blocked`, then read the orchestrator's summary.

**Approvals in one place** — a worker turns red and its permission question appears in the box at the bottom right;
answer with `y` / `a` (always) / `r` (reject) without leaving the chat.

![approvals](docs/approvals.svg)

**Usage per account** — the status bar shows each account's 5-hour usage, and the orchestrator hands new work to the
least-spent one.

![usage](docs/usage.svg)

> **Status: early (v0.3).** Its author runs it with three Claude accounts; Codex, OpenCode and Cursor
> profiles are wired up but barely tested. Issues and PRs welcome.

## How it works

- **One screen, three columns.** A conversation feed (messages, board notes, lifecycle events), the agent graph,
  and the focused agent's terminal — your chat. Under 140 columns the feed hides; under 100 the graph stacks above
  the chat.
- **Real agents, real terminals.** Every agent runs in its own PTY; coban emulates the screen (xterm) and reads a
  status from it: `working`, `blocked` (permission prompt), `limited` (usage limit), `idle`, `exited`.
- **The orchestrator drives a CLI, not an MCP server.** Pick its profile with the `+` bubble; it starts with a
  system prompt that teaches it the `coban` command, which talks to the app over a unix socket. Anything that can
  run a shell command can take part.
- **Alive, not busy.** Messages travel along the edges as packets (board notes fan out to everyone), working agents
  breathe, blocked ones blink, new ones fade in. Frames are drawn only while something moves.

```
coban agents                                   agents, model, status
coban map [subdir]                             repo map: files, line counts, symbol:line
coban spawn <profile> "<task>" [--name x] [--cwd dir] [--ctx where]...
                                               --ctx "file#sym1,sym2" | "file:10-80" | "file"
                                               inlines that code (line-numbered) into the task
coban post <id|user|all> "<message>"           direct message (queued until idle) or a board note (all)
coban inbox                                    your direct messages + board notes you haven't seen
coban board [--limit n]                        recent board notes
coban wait [id...] [--timeout s]               returns when an agent settles or mail arrives
coban read <id> [--lines n] [--raw]            an agent's screen, UI chrome stripped
coban approvals                                agents waiting on a permission question, parsed
coban approve <id> [yes|always|no]             answer it (always = the "Yes, and …" option)
coban key <id> <keys...>                       enter esc up down tab y 1 2 ...
coban usage                                    per-account usage, least spent first
coban kill <id> · coban log                    every command takes --json
```

## Install

Requires Node ≥ 24 on macOS or Linux.

```sh
npm install -g coban
cd ~/your-project && coban
```

### First run

On first start coban writes `~/.config/coban/config.json` and only offers what it finds: `claude`, `codex`,
`opencode` and `cursor-agent` that are on your `PATH`. A plain `claude` login (`~/.claude`) becomes profile `h1`.
Add more Claude accounts with `coban account add` (run it while the app is closed): it opens `claude` for the next
free profile (`h2`, `h3`...) in its own `~/.claude-hesapN` dir, you log in in the browser and type `/exit`, and the
profile is written to the config. Restart coban to see it. Edit the file any time, see Config below.

Note: the prompts coban gives the orchestrator and workers, and `coban --help`, are currently in Turkish.

### Troubleshooting

| symptom | fix |
|---|---|
| `SyntaxError` / `ERR_UNKNOWN_FILE_EXTENSION` on start | Node is too old, check `node -v` (needs ≥ 24) |
| agent shows `✗ hata` (error) | it can't work at all: logged out (`cursor-agent login`, `codex login`), expired token, or its model provider rejects requests. coban tells the orchestrator, which should move the task. For Claude, log in with the profile's `CLAUDE_CONFIG_DIR` |
| a profile is missing | its CLI is not on `PATH` when coban first ran: install it and delete the config file, or add the profile by hand |
| `coban çalışmıyor` from a `coban ...` command | open the TUI first with plain `coban`: those commands talk to the running app |
| stale socket after a crash | `rm ~/.coban/coban.sock` (coban also replaces it at start) |
| Codex: `coban: connect EPERM` | coban launches codex with `--sandbox workspace-write` and the socket's directory as a writable root, **without network access**. Some sandboxes (macOS Seatbelt) still refuse the unix socket then; opt in per profile with `"network": true` (adds `-c sandbox_workspace_write.network_access=true`: the agent's commands can then reach the internet too). If your profile sets its own `--sandbox`, it must allow the socket itself |
| Cursor asks before every `coban` call | add `"Shell(coban)"` to `permissions.allow` in `~/.cursor/cli-config.json`, or answer from coban's approval box |

### From source (development)

In a clone, TypeScript runs directly with no build step:

```sh
git clone https://github.com/cenkerarin/coban && cd coban
npm install
ln -s "$PWD/bin/coban" ~/.local/bin/coban
cd ~/your-project && coban
```

`npm run build` compiles to `dist/`, which `bin/coban` prefers when present.

## Config

`~/.config/coban/config.json` is created on first run. A profile is a command plus env vars, so several accounts
are just different `CLAUDE_CONFIG_DIR`s:

```json
{
  "orchestrator": "h1",
  "orchestratorModel": "claude-sonnet-5-5",
  "profiles": [
    { "id": "h1", "title": "Claude H1", "cmd": "claude --allowedTools 'Bash(coban:*)'", "model": "claude-opus-5-5",
      "promptArg": "-- {prompt}", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-hesap1" }, "color": "#F6D5C8" },
    { "id": "h2", "title": "Claude H2", "cmd": "claude --allowedTools 'Bash(coban:*)'", "model": "claude-sonnet-5-5",
      "promptArg": "-- {prompt}", "env": { "CLAUDE_CONFIG_DIR": "~/.claude-hesap2" }, "limit5h": 4000000 },
    { "id": "codex", "title": "Codex", "cmd": "codex", "promptArg": "{prompt}" }
  ]
}
```

`model` is appended as `--model <model>`; `orchestratorModel` overrides it for the profile running as orchestrator —
coordination is mostly reading and routing, so a cheaper model there saves the most.

## Notifications

On macOS coban shows a notification only when you actually need to act:

- **Blocked worker:** sent only if the worker stays *continuously* blocked for `notifyDelay` seconds (default 20) and
  its screen still shows a real permission/approval prompt. If the orchestrator or a standing rule answers sooner, nothing
  appears. The pending notice is cancelled on any status change or kill.
- **No notice** for the orchestrator's own blocks or for `manual` agents, nor for a blocked screen that is not a
  recognisable prompt.
- **Usage limit** (`limited`) notifies immediately (rare).
- The same agent+state repeats at most once per 5 minutes.

Config: `"notify": false` turns it off, `"notifyDelay": 30` changes the delay (seconds). `COBAN_NO_NOTIFY=1` also disables it.

## Accounts and limits

`coban usage` (and the bars in the status bar) read each Claude profile's session logs
(`$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`) and sum input + output + cache-creation tokens over 5 hours and 7 days.
The percentage is against the profile's `limit5h`; plans don't publish a token number, so the 5M default is a guess —
tune it per account. The orchestrator is told to give new work to the least-spent account.

When a worker hits a usage limit, coban **hands its task off** to the least-spent account of the same kind: the new
worker gets the original task plus the old worker's last screen, undelivered mail follows it, and the board and the
orchestrator are told.

## Approvals and the input line

- **One approval inbox.** When agents stop at a permission question, coban reads it off their screen — title,
  command or file, and the exact options — and lists them in a panel under the graph. `ctrl+b y` approves the
  selected one, `ctrl+b a` picks its "Yes, and …" option (shown verbatim, so you see what it grants), `ctrl+b r`
  rejects, `ctrl+b i` moves to the next; or click the buttons. The orchestrator can do the same with
  `coban approvals` / `coban approve`. Answers are given by moving the menu selection with arrow keys and pressing
  Enter (never by digit: Claude Code's folder-trust menu has no numbers and defaults to "No, exit"), and an answer
  is refused if the question changed since it was shown.
- **coban's own input line** sits under the chat: `ctrl+b c` (or a click) focuses it. `@h2 also add a refresh
  endpoint` goes to h2 without switching focus, `@all …` to the board, plain text to the focused agent; Tab
  completes agent names, Esc returns the keyboard to the agent.

The parser is built against real Claude Code screens (`test/fixtures/prompts`). Driving agents through the Agent SDK
would give exact events instead of screen reading, but its docs ask third-party tools not to offer claude.ai login,
so coban keeps running the unmodified Claude Code with your own login.

## Agents talking

- **Direct messages** (`coban post <id>`) are typed into the recipient's terminal once it is idle.
- **The board** (`coban post all`) is for things everyone should know — changed interfaces, who is on which file,
  decisions. Notes are pulled, not pushed: `coban inbox` returns each note once, and workers are told to check it
  after every major step and before editing shared files, so idle agents aren't woken (and billed) for every note.
  It is mirrored to `.coban/board.md`; `ctrl+b m` opens it as a panel.
- Agents opened by hand show as `manuel`; the orchestrator is told to use idle ones before spawning new workers, and
  coban prepends the worker brief to the first message they get.

## Queues, worktrees and verify gates

Three `coban spawn` flags let the orchestrator hand off sequencing, isolation and checking to coban itself:

- **`--after id1,id2`** queues the spawn. It starts once every listed agent is done: idle or exited after having
  worked, with its verify gate passed (or given up), or killed. `coban agents` lists queued spawns as
  `kuyrukta (bekliyor: …)`; `coban kill <id>` cancels one. Dependencies may themselves be queued (chains).
- **`--worktree[=branch]`** creates a git worktree next to the repo (`<repo>-<id>`, branch `coban/<id>` unless
  named; an existing branch is checked out) and starts the worker there, so two workers can edit the same files.
  `coban kill <id> --rm-worktree` removes it afterwards — only when it has no uncommitted changes; the branch is
  always kept.
- **`--verify "<cmd>"`** runs `cmd` with `sh` in the worker's directory each time it settles after working. On
  failure the exit code and the output's last 40 lines are sent back to the worker to fix; after `verifyTries`
  failures (config, default 3) or if the worker has exited, the orchestrator is told instead. A pass is reported to
  the orchestrator, and `coban agents` shows `doğrulama:<state>`. Set `verifyAllow` in the config (a list of
  regexes, each must match the whole command) to restrict which commands may run; unset, any command is accepted.

```sh
coban spawn h1 "HEDEF: …" --name api --worktree --verify "npx tsc --noEmit && npm test"
coban spawn h2 "HEDEF: docs for the new API" --after api
```

## Keeping context small

Each request an agent makes re-reads its whole context (Claude Code alone is ~45k tokens before any work), so coban
keeps what lands there lean:

- one-line CLI output; `coban read` returns 20 lines with agent UI chrome stripped;
- workers send ≤5-line summaries and put long results in `.coban/reports/<id>.md` (git-ignored automatically);
- the orchestrator learns the repo from `coban map` (≈400 tokens for this repo) and hands workers the relevant code
  with `--ctx` — coban extracts symbols/line ranges itself (no model involved) so workers don't spend requests
  searching;
- tasks follow a template: **HEDEF / DOSYALAR / KISITLAR / DOĞRULAMA / BİTTİ SAYILIR**
  (goal, files, constraints, verification, done when).

## Keys

Mouse: click a bubble to focus it, click `+` to add an agent, scroll the feed with the wheel. Mouse events in the
chat are forwarded when the agent asks for them.

`ctrl+b` then: `c` input line · `y`/`a`/`r` approve / always / reject · `i` next approval · `n` new agent · `1-9` select · `j`/`k` next/prev · `o` orchestrator · `m` board panel ·
`l` toggle feed · `←`/`→` (or `<`/`>`) widen / narrow the chat, arrows repeat for a second without `ctrl+b` (saved as `chatWidth`, 0.3-0.6; the `l` feed toggle is saved as `feedHidden`) · `s` select mode (release the mouse to copy text) · `u` next unread · `x` close agent · `q` quit ·
`ctrl+b` send a literal ctrl+b.

## Development

```sh
npm test            # unit tests + an end-to-end run of the real TUI in a pty with fake agents
npm run typecheck
npm run snapshot    # regenerate docs/screenshot.svg
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how the code is laid out.

### Who may do what

Only the user (the `coban` CLI outside an agent) and the orchestrator may call `spawn` (incl. `--worktree` /
`--verify`), `approve`, `key`, `kill` and `rule`; workers read and message (`post`, `send`, `inbox`, `board`,
`agents`, `read`, `map`, `wait`), so a worker cannot approve its own permission prompt. OpenCode workers get a
prompt-free allow only for those read/messaging subcommands. When an agent can't work, the orchestrator is told a
fixed category (no login / expired token / provider rejected), never the raw screen line (shown to you in the feed).
Identity is a secret, not a name: every agent gets its own random `COBAN_TOKEN` (`COBAN_AGENT` is display only).
There is **no user secret** anywhere an agent could read it — no token file, no env var, no second socket (agents run
as your OS user and can read `~/.coban` and find any socket; nothing in there grants rights). User rights exist only
inside the coban window itself. A request on the socket without a valid agent token (another terminal of yours, or an
agent that dropped its token) is `anon`: reading and messaging work, but `spawn`/`approve`/`key`/`kill`/`rule` pop up
an **ONAY GEREKİYOR** box in the coban window showing the full request (every field, uncut; control and bidi
characters escaped). Only your `y` there runs it (`n`/`esc` refuses; keys in the first 0.6 s are ignored; refused
after 2 min). Agent tokens never get such a box: rule edits from any agent, even the orchestrator, are refused, and
`coban rule add/rm` won't run inside an agent's environment (also not the offline config edit). Agent names are
plain (`[A-Za-z0-9._-]`, no `coban`/`anon`); what an agent posts is normalized, stripped of invisible characters and
quoted line by line, so it can't fake coban's `[coban …]` framing. Socket `0600`, `~/.coban` `0700` (that stops other
OS users, not agents). Remaining risk: an agent allowed to run arbitrary shell commands (outside the prompt-free
`coban …` allowlist) can read `~/.coban/history.jsonl`, other agents' environments (their tokens, e.g. the
orchestrator's) and could ask you through the box — read it before pressing `y`. These checks stop prompt-injected or
confused agents, not a deliberately hostile one with free shell.

## Known gaps

No scrollback in the chat, no split view, no kitty keyboard protocol (shift+enter), no session restore yet.
Status detection is screen heuristics and may need tuning per CLI
version. coban captures the mouse: to copy text press `ctrl+b s`, or use your terminal's override (shift-drag in
Ghostty/cmux, ⌥-drag in iTerm2).

## License

MIT

### Standing approvals

`coban rule add "<regex>" [--cwd dir] [--profile id]` auto-answers *yes* (never "always") to a permission prompt whose text
matches. The regex is anchored and must match the whole text: the dialog's title and *every* line of it (Tip: lines
too), joined by ` · `, exactly as the first line of `coban approvals` shows it, e.g.
`Bash command · Remove the build folder · rm -rf build`. A prompt coban can't prove it read whole (top border off
screen, more than 14 lines, a plain `(y/n)` question, a line that itself contains ` · `) is never auto-approved and is
marked in `coban approvals`. Each regex runs under a 50 ms limit (a catastrophic pattern counts as no match). There are no
default rules and only the user (not an agent) can add or remove them. Rules written for 0.3 (body only) no longer
match: prefix them with the title.
`coban rule list` / `coban rule rm <n>`; rules live in the config's `rules`.
