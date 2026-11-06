import pty from 'node-pty';
import xterm from '@xterm/headless';
import { EventEmitter } from 'node:events';
import type { Profile } from './config.ts';

const { Terminal } = xterm;

export type Status = 'starting' | 'working' | 'blocked' | 'limited' | 'idle' | 'exited';
export type Role = 'orchestrator' | 'worker' | 'manual';

export type Msg = { id: number; from: string; to: string; text: string; ts: number; delivered: boolean };

// Screen heuristics. Checked against the bottom of the visible screen.
const BLOCKED = /Do you want to (proceed|make this edit|create|allow|run)|Would you like to (run|make|proceed|allow)|Allow (this|command|once)|\(y\/n\)|\[y\/N\]|Approve\b.*\?|Press enter to confirm|trust (this|the files in this) folder|Do you trust/i;
// A CLI's own limit banner: a short line of its own, optionally behind one bullet/box glyph, sitting in the last few
// non-chrome lines of the screen (just above the idle prompt). Line-anchored on purpose: the same words inside a task
// text, a prompt echo ('> …'), a quote or mid-sentence tool output must never trigger a handoff.
const LIMIT_BANNER = /^\s{0,4}(?:[⎿●•✻*·]\s{0,4})?(?:(?:Claude(?: AI)? )?usage limit reached|(?:5-hour|weekly|session|daily|opus|sonnet) limit reached|You(?:'|’)?ve (?:hit|reached) your (?:\w+[ -])?(?:usage )?limit|You have (?:hit|reached) your (?:\w+[ -])?(?:usage )?limit|You(?:'|’)re out of (?:credits|extra usage))(?:\s*$|[\s.!,:;|∙·–—(-])/i;
const LIMIT_CHROME = /^\s*([─━═╌┄\-]{8,}|[╭╰│┃].*|❯.*|>.*|[⏵►▶]{2}.*|\? for shortcuts.*)$/;
const LIMIT_TAIL_LINES = 4;
// Broad form, only for masking quoted screen text (handoff tasks) so it can't re-trigger a limit in the new worker.
const LIMIT_WORDS = /(?:(?:usage|rate) limit|limit reached|(?:hit|reached) your[^\n]{0,24}?limit|out of (?:credits|extra usage))/gi;

export function limitBanner(screen: string): boolean {
  const lines = screen.split('\n').filter((l) => l.trim() && !LIMIT_CHROME.test(l)).slice(-LIMIT_TAIL_LINES);
  return lines.some((l) => l.length <= 200 && LIMIT_BANNER.test(l));
}

export function maskLimitText(text: string): string {
  return text.replace(LIMIT_WORDS, (m) => `[${m.replace(/limit/gi, 'l*mit')}]`);
}
const BUSY = /esc to interrupt|esc to cancel|ctrl\+c to (interrupt|stop)|Working \(|Thinking\.\.\./i;
const QUIET_MS = 1500;

export class Agent extends EventEmitter {
  id: string;
  profile: Profile;
  role: Role;
  task: string;
  cwd: string;
  term: InstanceType<typeof Terminal>;
  proc: pty.IPty;
  status: Status = 'starting';
  settledSeq = 0;        // bumps every time the agent settles (idle/blocked/limited/exited)
  unread = false;        // settled while not focused
  lastOutput = Date.now();
  cursorVisible = true;
  exitCode: number | null = null;
  inbox: Msg[] = [];
  model = '';
  briefed = false;      // has received the coban worker brief
  handedOff = false;    // hit a limit and its task was already handed to another account (hub.handoff)

  constructor(o: { id: string; profile: Profile; role: Role; task: string; cwd: string; cmd: string; env: Record<string, string>; cols: number; rows: number }) {
    super();
    this.id = o.id;
    this.profile = o.profile;
    this.role = o.role;
    this.task = o.task;
    this.cwd = o.cwd;
    this.term = new Terminal({ cols: o.cols, rows: o.rows, scrollback: 2000, allowProposedApi: true });
    // Track DECTCEM (cursor show/hide); headless xterm doesn't expose it.
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (p) => { if (p.includes(25)) this.cursorVisible = true; return false; });
    this.term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (p) => { if (p.includes(25)) this.cursorVisible = false; return false; });

    // /bin/sh, not the user's shell: profiles are plain commands and sh exists everywhere (zsh is missing on most Linux).
    this.proc = pty.spawn('/bin/sh', ['-c', `exec ${o.cmd}`], {
      name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env,
    });
    this.proc.onData((d) => {
      this.lastOutput = Date.now();
      this.term.write(d, () => this.emit('render'));
    });
    // Replies to terminal queries (DA, DSR, ...) go back to the program.
    this.term.onData((d) => { if (this.exitCode === null) this.proc.write(d); });
    this.proc.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      this.setStatus('exited');
      this.emit('render');
    });
  }

  screenText(lines = 40, scrollback = false): string {
    const buf = this.term.buffer.active;
    // Drop blank rows below the content first, then take the last `lines` rows.
    let end = buf.length;
    while (end > 0 && !buf.getLine(end - 1)?.translateToString(true).trim()) end--;
    const start = Math.max(scrollback ? 0 : buf.baseY, end - lines);
    const out: string[] = [];
    for (let y = start; y < end; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '');
    return out.join('\n');
  }

  tick() {
    if (this.status === 'exited') return;
    const tail = this.screenText(18);
    let next: Status;
    if (limitBanner(tail) && !BUSY.test(tail)) next = 'limited';
    else if (BLOCKED.test(tail)) next = 'blocked';
    // A visible "esc to interrupt" means real work, even right after launch (workers get their task as an argv
    // prompt and never pass through idle). Bare output without it is still startup noise.
    else if (BUSY.test(tail)) next = 'working';
    else if (Date.now() - this.lastOutput < QUIET_MS) next = this.status === 'starting' ? 'starting' : 'working';
    else next = 'idle';
    this.setStatus(next);
  }

  setStatus(s: Status) {
    if (s === this.status) return;
    const prev = this.status;
    this.status = s;
    if (s !== 'working' && s !== 'starting') this.settledSeq++;
    this.emit('status', s, prev);
  }

  // Type a prompt into the agent and submit it.
  deliver(text: string) {
    if (this.exitCode !== null) return;
    const body = this.term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text.replace(/\s*\n\s*/g, ' ');
    this.proc.write(body);
    setTimeout(() => this.proc.write('\r'), 250);
    this.lastOutput = Date.now();
    this.setStatus('working');
  }

  resize(cols: number, rows: number) {
    if (cols === this.term.cols && rows === this.term.rows) return;
    this.term.resize(cols, rows);
    if (this.exitCode === null) this.proc.resize(cols, rows);
  }

  kill() {
    if (this.exitCode === null) this.proc.kill();
    this.term.dispose();
  }
}

const KEYS: Record<string, string> = {
  enter: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z', space: ' ',
  backspace: '\x7f', 'ctrl-c': '\x03', 'ctrl-d': '\x04',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
};

export function keyBytes(agent: Agent, key: string): string {
  const k = key.toLowerCase();
  if (agent.term.modes.applicationCursorKeysMode && /^(up|down|left|right)$/.test(k)) {
    return '\x1bO' + { up: 'A', down: 'B', right: 'C', left: 'D' }[k as 'up'];
  }
  return KEYS[k] ?? key;
}
