# Contributing

Thanks for looking. coban is small on purpose: plain TypeScript run directly by Node (≥ 24), two runtime
dependencies (`node-pty`, `@xterm/headless`), no build step.

```sh
npm install
npm test           # ~15 s: unit tests + the real TUI in a pty with fake agents
npm run typecheck
```

## Layout

| file | what it does |
|---|---|
| `bin/coban` | launcher (`node src/cli.ts`) |
| `src/cli.ts` | argument parsing; no args starts the TUI, anything else is a client call over the unix socket |
| `src/hub.ts` | agents, messages, board, `wait`, automatic handoff, the socket RPC, and the prompts given to the orchestrator and workers |
| `src/agent.ts` | one agent: a PTY plus a headless xterm, and the screen heuristics that set its status |
| `src/tui.ts` | layout (feed · graph · chat), the cell canvas, animations, input and mouse |
| `src/context.ts` | `coban map` and `--ctx` snippet extraction |
| `src/usage.ts` | per-account token usage from Claude Code session logs |
| `src/config.ts` | profiles and paths (`~/.config/coban/config.json`, `~/.coban/coban.sock`) |
| `test/` | `node:test` suites; `test/helpers.ts` starts a real coban in a pty with `test/fixtures/fake-agent.mjs` |
| `scripts/snapshot.ts` | renders `docs/screenshot.svg` with scripted demo agents |

## Guidelines

- **Keep agent context lean.** Anything a CLI command prints ends up in an agent's context and is re-read on every
  later request. Prefer one-liners; put long output behind a flag.
- **Test against fake agents.** `startCoban()` in `test/helpers.ts` gives you a running TUI, its screen, and a CLI
  that can act as any agent (`cli('w1', 'post', 'all', '…')`). Real CLIs (Claude Code, Codex, …) are never needed in
  tests.
- **Screen heuristics are fragile.** If you add patterns to `BLOCKED`/`LIMITED`/`BUSY` in `src/agent.ts`, include the
  exact text the CLI prints and its version in the PR.
- **Don't draw when idle.** The TUI only schedules frames while something moves; the e2e test checks that an idle
  screen writes nothing.
- User-facing strings and agent prompts are in Turkish today. English (or i18n) PRs are welcome.
