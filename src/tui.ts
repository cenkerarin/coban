import type { Agent, Msg, Role, Status } from './agent.ts';
import type { Hub } from './hub.ts';
import { fmtTokens, type AccountUsage } from './usage.ts';
import { pickOption, type Choice, type Prompt } from './prompt.ts';
import { saveLayout } from './config.ts';

const PREFIX = '\x02'; // ctrl+b
const out = process.stdout;
const ESC = '\x1b[';
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

const STATUS_STYLE: Record<Status, [string, string, string]> = {
  //          glyph, color,        label
  starting: ['◌', '38;5;244', 'açılıyor'],
  working:  ['●', '38;5;214', 'çalışıyor'],
  blocked:  ['!', '1;38;5;203', 'izin bekliyor'],
  limited:  ['⧗', '1;38;5;199', 'limit doldu'],
  error:    ['✗', '1;38;5;196', 'hata'],
  idle:     ['○', '38;5;248', 'boşta'],
  exited:   ['×', '38;5;240', 'kapandı'],
};

// Visual language borrowed from Sokratic's bubble graph: gold root, gold heavy root edges,
// nodes outlined in their own (profile) colour, centred labels.
const GOLD = '38;2;203;163;67';      // #cba343 root
const GOLD_DEEP = '38;2;184;134;42'; // #b8862a root edges
const DIM = '38;5;244';
const MARK = '38;5;114';
const SEP = '0;38;5;238';

type RGB = [number, number, number];
const GOLD_RGB: RGB = [203, 163, 67];
const BG_RGB: RGB = [32, 32, 32];
const WHITE: RGB = [255, 255, 255];
const RED: RGB = [255, 95, 95];
const rgbOf = (h?: string): RGB | null => {
  const m = h?.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i] - v) * clamp(t, 0, 1)) as RGB;
const fg = (c: RGB, f = 1) => `38;2;${c.map((v) => clamp(Math.round(v * f), 0, 255)).join(';')}`;
const hex = (h?: string) => { const c = rgbOf(h); return c ? fg(c) : '39'; };
const fit = (s: string, w: number) => (w <= 0 ? '' : s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s + ' '.repeat(w - s.length));
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const CHAT_SHARE = 0.42, CHAT_SHARE_MIN = 0.3, CHAT_SHARE_MAX = 0.6, CHAT_SHARE_STEP = 0.04;
const SAVE_DEBOUNCE_MS = 300;
// A config value may be anything: non-numbers fall back to the default, numbers are clamped.
const sanitizeShare = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? clamp(v, CHAT_SHARE_MIN, CHAT_SHARE_MAX) : CHAT_SHARE;
const RESIZE_REPEAT_MS = 1000;

// The chat takes `share` of the screen; the feed gives up room in proportion so the graph isn't the only one squeezed.
export function columnWidths(W: number, share: number, feedHidden: boolean) {
  let fw = feedHidden || W < 140 ? 0 : clamp(Math.round(W * 0.24 * (1 - share) / (1 - CHAT_SHARE)), 30, 56);
  let pw = clamp(Math.round(W * share), 64, 130);
  let gw = W - fw - pw - (fw ? 2 : 1);
  if (gw < 40) { const t = Math.min(40 - gw, pw - 60); pw -= t; gw += t; }
  if (gw < 40 && fw) { const t = Math.min(40 - gw, fw - 26); fw -= t; gw += t; }
  return { fw, gw, pw };
}

const hhmm = (ts: number) => { const t = new Date(ts); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const FRAME_MS = 80;

// ── per-account usage bars (cached; refreshed every 30 s, never in the render path) ──
const USAGE_MS = 30_000;
const usageBarSegs = (u: AccountUsage[], room: number): { segs: Seg[]; len: number } => {
  const segs: Seg[] = [];
  let len = 0;
  const bw = room >= u.length * 20 ? 6 : 4;
  for (const a of u) {
    const pct = Math.max(0, a.pct5h || 0);
    const n = Math.round(clamp(pct, 0, 1) * bw);
    const col = a.limited ? '1;38;5;203' : pct > 0.8 ? '1;38;5;214' : GOLD;
    const known = a.limit5h > 0; // non-Claude accounts have no usage logs
    const label = `${a.profileId} `, tail = ` ${known ? Math.round(pct * 100) + '%' : '?'}${a.limited ? '⧗' : ''}`;
    const w = label.length + bw + tail.length + 2;
    if (len + w > room) break;
    segs.push([label, DIM], ['▰'.repeat(n), col], ['▱'.repeat(bw - n), '38;5;238'], [tail + '  ', a.limited ? col : '38;5;250']);
    len += w;
  }
  return { segs, len };
};

// ── a tiny cell canvas with box-drawing line joins ─────────────
type Seg = [text: string, sgr: string];
const segLen = (segs: Seg[]) => segs.reduce((n, [t]) => n + [...t].length, 0);
const N = 1, E = 2, S = 4, W_ = 8;
const HEAVY: Record<number, string> = {
  [N]: '┃', [S]: '┃', [N | S]: '┃', [E]: '━', [W_]: '━', [E | W_]: '━',
  [S | E]: '┏', [S | W_]: '┓', [N | E]: '┗', [N | W_]: '┛',
  [N | S | E]: '┣', [N | S | W_]: '┫', [E | W_ | S]: '┳', [E | W_ | N]: '┻', [N | E | S | W_]: '╋',
};

class Canvas {
  w: number; h: number;
  ch: string[]; sgr: string[]; set: boolean[]; mask: Uint8Array;
  lineSgr = `0;${GOLD_DEEP}`;
  constructor(w: number, h: number) {
    this.w = Math.max(0, w); this.h = Math.max(0, h);
    const n = this.w * this.h;
    this.ch = Array(n).fill(' '); this.sgr = Array(n).fill('0'); this.set = Array(n).fill(false);
    this.mask = new Uint8Array(n);
  }
  put(x: number, y: number, text: string, sgr: string) {
    if (y < 0 || y >= this.h) return;
    for (const c of text) {
      if (x >= 0 && x < this.w) { const i = y * this.w + x; this.ch[i] = c; this.sgr[i] = sgr; this.set[i] = true; }
      x++;
    }
  }
  segs(x: number, y: number, w: number, segs: Seg[], bg: string, center = true) {
    if (w <= 0) return;
    let cells = segs.flatMap(([t, s]) => [...t].map((c) => [c, s] as Seg));
    if (cells.length > w) cells = [...cells.slice(0, w - 1), ['…', cells[w - 1][1]]];
    const pad = center ? Math.floor((w - cells.length) / 2) : 0;
    this.put(x, y, ' '.repeat(w), `0${bg}`);
    cells.forEach(([c, s], i) => this.put(x + pad + i, y, c, `0${s ? ';' + s : ''}${bg}`));
  }
  private bit(x: number, y: number, b: number) {
    if (x >= 0 && x < this.w && y >= 0 && y < this.h) this.mask[y * this.w + x] |= b;
  }
  hline(y: number, x1: number, x2: number) {
    for (let x = x1; x <= x2; x++) { if (x > x1) this.bit(x, y, W_); if (x < x2) this.bit(x, y, E); }
  }
  vline(x: number, y1: number, y2: number) {
    for (let y = y1; y <= y2; y++) { if (y > y1) this.bit(x, y, N); if (y < y2) this.bit(x, y, S); }
  }
  row(y: number, x0 = 0, x1 = this.w): string {
    let s = '', last = '';
    for (let x = x0; x < x1; x++) {
      const i = y * this.w + x;
      let c = this.ch[i] ?? ' ', g = this.sgr[i] ?? '0';
      if (!this.set[i] && this.mask[i]) { c = HEAVY[this.mask[i]] ?? '╋'; g = this.lineSgr; }
      if (g !== last) { s += `\x1b[${g}m`; last = g; }
      s += c;
    }
    return s + '\x1b[0m';
  }
}

type Hit = { kind: 'agent'; id: string } | { kind: 'add-orch' } | { kind: 'add-worker' };
type Box = { x: number; y: number; w: number; h: number; hit: Hit };
type Item = { kind: 'agent'; a: Agent } | { kind: 'add' } | { kind: 'more'; n: number; first: string };
type Level = 'full' | 'compact' | 'mini';
type Plan = { G: number; level: Level; bh: number; bw: number; perRow: number; nL: number; nR: number; rows: number; items: Item[] };
type Pt = [number, number];
type Node = { ax: number; ay: number; bus: number };   // joint on the bubble's top edge + the bus row above it
type Packet = { from: string; to: string; color: RGB; t0: number; dur: number };
type FeedEvent = { ts: number; id: string; glyph: string; color: string; text: string; detail?: string };

// Screen geometry. 'cols': feed | graph | chat side by side; 'stack': graph above the chat (narrow terminals).
type Layout = {
  mode: 'cols' | 'stack';
  fx: number; fw: number;        // feed column (fw = 0 when hidden)
  gx: number; gw: number;        // graph column
  px: number; pw: number;        // chat (focused agent terminal) column
  paneTop: number; P: number;    // first terminal row and number of terminal rows
  cy: number;                    // composer: separator row (input row is cy + 1), spans [px, px + pw)
  p: Plan;
};
type Approval = { id: string; profile: string; title: string; prompt: Prompt | null };
type Rect = { x: number; y: number; w: number; h: number };

export class Tui {
  hub: Hub;
  prev: string[] = [];
  scheduled = false;
  animPending = false;
  prefix = false;
  mode: 'normal' | 'pick' = 'normal';
  pickRole: Role = 'manual';
  pickIdx = 0;
  notice = '';
  showBoard = false;
  feedHidden = false;   // restored from the config in the constructor
  chatShare = CHAT_SHARE;
  saveTimer?: NodeJS.Timeout;
  resizeUntil = 0; // until then, left/right arrows keep resizing without ^b
  selectMode = false;  // mouse released to the terminal so text can be selected/copied
  composing = false;   // keystrokes go to coban's own input line instead of the focused agent
  draft = '';
  pending: Approval[] = [];
  approvalSel = 0;
  showApprovals = false; // stacked layout only: the panel is opened on demand
  approvalsBox?: Rect;
  approvalHits: { x0: number; x1: number; y: number; id: string; choice?: Choice }[] = [];
  feedScroll = 0;      // lines scrolled up from the newest feed entry
  boardBox?: { x: number; y: number; w: number; h: number };
  noticeTimer?: NodeJS.Timeout;
  outerAppCursor = false;
  outerMouse = '';
  now = Date.now();
  hits: Box[] = [];
  pickHits: { y: number; x0: number; x1: number; idx: number }[] = [];
  pickBox?: { x: number; y: number; w: number; h: number };
  geo!: Layout;

  // animation state
  nodes = new Map<string, Node>();
  orchJoint: Pt = [0, 0];
  packets: Packet[] = [];
  bornAt = new Map<string, number>();
  arrivedAt = new Map<string, number>();
  events: FeedEvent[] = [];
  lastStatus = new Map<string, Status>();
  workingSince = new Map<string, number>();
  doneCandidates = new Map<string, number>(); // id → when it went idle after working
  lastLogId = 0;

  constructor(hub: Hub) {
    this.hub = hub;
    this.chatShare = sanitizeShare(hub.cfg.chatWidth);
    this.feedHidden = hub.cfg.feedHidden === true;
    hub.on('render', (a: Agent) => { if (a.id === hub.focus) this.schedule(); });
    hub.on('change', () => { this.observe(); this.schedule(); });
    hub.on('board', () => this.schedule());
    hub.on('handoff', (h: { from: string; to: string | null; fromProfile: string; toProfile: string | null }) => {
      if (h.to) this.event(h.to, '⇄', STATUS_STYLE.limited[1], `devir: ${h.from} (${h.fromProfile}) → ${h.toProfile}`);
      else this.event(h.from, '⇄', STATUS_STYLE.limited[1], `devir yapılamadı${h.toProfile ? ` (${h.toProfile})` : ': uygun hesap yok'}`);
      this.usageAt = 0; this.schedule();
    });
    hub.on('notify', (m: Msg) => this.flash(`✉ ${m.from}: ${flat(m.text)}`, 15000));
  }

  get paneSize() {
    const L = this.layout(out.columns, out.rows);
    return { cols: Math.max(20, L.pw), rows: Math.max(3, L.P) };
  }

  start() {
    out.write('\x1b[?1049h\x1b[?2004h\x1b[2J');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d: Buffer) => this.input(d.toString('utf8')));
    out.on('resize', () => {
      this.prev = [];
      out.write('\x1b[2J');
      this.render(); // recomputes layout and resizes every agent's pty
    });
    this.schedule();
  }

  stop() {
    this.flushChatWidth();
    out.write('\x1b[0m\x1b[?25h\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l');
    process.stdin.setRawMode(false);
  }

  flash(text: string, ms = 4000) {
    this.notice = text;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = ''; this.schedule(); }, ms);
    out.write('\x07');
    this.schedule();
  }

  // ── hub observation: feed events + animations ────────────────
  event(id: string, glyph: string, color: string, text: string, detail?: string) {
    this.events.push({ ts: Date.now(), id, glyph, color, text, detail });
    this.hub.record({ ts: Date.now(), kind: 'event', id, text, detail });
    if (this.events.length > 300) this.events.shift();
  }

  observe() {
    const hub = this.hub, now = Date.now();
    for (const [id, a] of hub.agents) {
      const prev = this.lastStatus.get(id);
      if (prev === undefined) {
        this.bornAt.set(id, now);
        const role = a.role === 'orchestrator' ? 'orkestratör' : a.role === 'manual' ? 'manuel agent' : 'işçi';
        this.event(id, '✦', hex(a.profile.color), `${role} açıldı · ${a.profile.title}`, a.task ? flat(a.task.replace(/^\[coban\][\s\S]*?GÖREV:\s*/, '')) : undefined);
      } else if (prev !== a.status) {
        if (a.status === 'working') { this.workingSince.set(id, now); this.doneCandidates.delete(id); }
        if (a.status === 'blocked' && id !== hub.orchestratorId) this.event(id, '!', STATUS_STYLE.blocked[1], 'izin bekliyor');
        if (a.status === 'limited') this.event(id, '⧗', STATUS_STYLE.limited[1], 'kullanım limiti doldu');
        if (a.status === 'error') this.event(id, '✗', STATUS_STYLE.error[1], 'çalışamıyor (giriş/sağlayıcı hatası)', a.error);
        if (a.status === 'exited') this.event(id, '×', DIM, 'süreç kapandı');
        if (a.status === 'idle' && prev === 'working' && id !== hub.orchestratorId) this.doneCandidates.set(id, now);
        if (a.status === 'idle' && prev === 'starting') this.event(id, '○', DIM, 'hazır');
      }
      this.lastStatus.set(id, a.status);
    }
    for (const id of [...this.lastStatus.keys()]) {
      if (!hub.agents.has(id)) { this.lastStatus.delete(id); this.doneCandidates.delete(id); this.event(id, '×', DIM, 'kapatıldı'); }
    }
    // new messages → packets travelling along the graph
    for (const m of hub.log) {
      if (m.id <= this.lastLogId) continue;
      this.lastLogId = m.id;
      const from = hub.agents.has(m.from) ? m.from : m.from === 'user' ? '' : hub.orchestratorId;
      const color = rgbOf(hub.agents.get(m.from)?.profile.color) ?? GOLD_RGB;
      const targets = m.to === 'all' ? hub.order.filter((id) => id !== m.from) : hub.agents.has(m.to) ? [m.to] : [];
      targets.forEach((to, i) => { if (from && to !== from) this.packets.push({ from, to, color, t0: now + i * 70, dur: 0 }); });
      if (!targets.length && from) this.arrivedAt.set(from, now);
      if (!from) for (const to of targets) this.arrivedAt.set(to, now);
    }
  }

  // "bitirdi" only once an agent has stayed idle a moment, so brief pauses between tool calls don't spam the feed
  settleDone() {
    for (const [id, at] of this.doneCandidates) {
      const a = this.hub.agents.get(id);
      if (!a || a.status !== 'idle') { this.doneCandidates.delete(id); continue; }
      if (this.now - at < 2500) continue;
      this.doneCandidates.delete(id);
      const took = this.workingSince.has(id) ? Math.round((at - this.workingSince.get(id)!) / 1000) : 0;
      this.event(id, '✓', MARK, took >= 5 ? `durdu · ${took} sn çalıştı` : 'durdu');
    }
  }

  animating(): boolean {
    const now = this.now;
    if (this.packets.length || this.doneCandidates.size) return true;
    for (const a of this.hub.agents.values()) if (a.status === 'working' || a.status === 'starting' || a.status === 'blocked') return true;
    for (const t of this.bornAt.values()) if (now - t < 800) return true;
    for (const t of this.arrivedAt.values()) if (now - t < 700) return true;
    const last = this.hub.log.at(-1);
    return !!last && now - last.ts < 2000;
  }

  // ── input ────────────────────────────────────────────────────
  input(d: string): void {
    if (d.includes('\x1b[<')) {
      d = d.replace(MOUSE_RE, (_, b, x, y, m) => { this.mouse(Number(b), Number(x) - 1, Number(y) - 1, m === 'M'); return ''; });
      if (!d) return;
    }
    const hub = this.hub;
    if (this.mode === 'pick') return this.pickKey(d);
    if (this.prefix) {
      this.prefix = false;
      return this.command(d);
    }
    if (Date.now() < this.resizeUntil && /^\x1b[\[O][CD]$/.test(d)) return this.command(d);
    if (d === PREFIX) { this.prefix = true; return this.schedule(); }
    if (d[0] === PREFIX) { this.prefix = true; return this.input(d.slice(1)); } // ^b and the key in one read
    if (this.composing) return this.composeKey(d);

    const a = hub.agents.get(hub.focus);
    if (!a) {
      if (!hub.orchestratorId && (d === '\r' || d === ' ' || d === '+')) this.openPicker('orchestrator');
      return;
    }
    if (a.exitCode !== null) return;
    if (!a.term.modes.bracketedPasteMode) d = d.replace(/\x1b\[20[01]~/g, '');
    a.proc.write(d);
  }

  command(c: string) {
    const hub = this.hub;
    const idx = hub.order.indexOf(hub.focus);
    const move = (n: number) => hub.order.length && hub.setFocus(hub.order[(idx + n + hub.order.length) % hub.order.length]);
    switch (c) {
      case 'n': this.openPicker('manual'); break;
      case 'j': case '\x1b[B': case '\x1bOB': move(1); break;
      case 'k': case '\x1b[A': case '\x1bOA': move(-1); break;
      case 'o': if (hub.orchestratorId) hub.setFocus(hub.orchestratorId); else this.openPicker('orchestrator'); break;
      case 'm': this.showBoard = !this.showBoard; this.prev = []; out.write('\x1b[2J'); break;
      case 'l': this.feedHidden = !this.feedHidden; this.saveSoon(); this.prev = []; out.write('\x1b[2J'); break;
      case '<': case '\x1b[D': case '\x1bOD': this.resizeChat(CHAT_SHARE_STEP); break;
      case '>': case '\x1b[C': case '\x1bOC': this.resizeChat(-CHAT_SHARE_STEP); break;
      case 's': this.selectMode = !this.selectMode; break;
      case 'c': this.composing = !this.composing; break;
      case 'y': this.answerSelected('yes'); break;
      case 'a': this.answerSelected('always'); break;
      case 'r': this.answerSelected('no'); break;
      case 'i':
        if (this.geo?.mode === 'stack' && !this.showApprovals) this.showApprovals = true;
        else if (this.pending.length > 1) this.approvalSel = (this.approvalSel + 1) % this.pending.length;
        else if (this.geo?.mode === 'stack') this.showApprovals = false;
        break;
      case 'u': { const u = hub.order.find((id) => hub.agents.get(id)!.unread); if (u) hub.setFocus(u); break; }
      case 'x': {
        const a = hub.agents.get(hub.focus);
        if (!a) break;
        if (a.role === 'orchestrator' && a.exitCode === null) this.flash('orkestratör kapatılamaz (çıkış: ^b q)');
        else hub.kill(a.id);
        break;
      }
      case 'q': process.emit('SIGTERM'); return;
      case PREFIX: hub.agents.get(hub.focus)?.proc.write(PREFIX); break;
      default:
        if (/^[1-9]$/.test(c) && hub.order[Number(c) - 1]) hub.setFocus(hub.order[Number(c) - 1]);
    }
    this.schedule();
  }

  flushChatWidth() {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try { saveLayout({ chatWidth: this.chatShare, feedHidden: this.feedHidden }); } catch { /* an unwritable config must not crash the TUI */ }
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushChatWidth(), SAVE_DEBOUNCE_MS);
  }

  resizeChat(delta: number) {
    const a = this.hub.agents.get(this.hub.focus);
    if (this.geo?.mode === 'stack' || !a || a.exitCode !== null) return;   // nothing to resize / no chat to show
    this.chatShare = sanitizeShare(Math.round((this.chatShare + delta) * 100) / 100);
    this.saveSoon();
    this.resizeUntil = Date.now() + RESIZE_REPEAT_MS;
    this.prev = [];
    out.write('\x1b[2J');
  }

  // ── coban's own input line: "@id text" goes to that agent, "@all text" to the board, plain text to the focus ──
  composeKey(d: string) {
    const paste = d.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/);
    if (paste) { this.draft += paste[1].replace(/\r\n?/g, '\n'); return this.schedule(); }
    if (d === '\x1b') this.composing = false;
    else if (d === '\r') this.send();
    else if (d === '\x7f' || d === '\b') this.draft = [...this.draft].slice(0, -1).join('');
    else if (d === '\x15') this.draft = '';
    else if (d === '\t') {
      const m = this.draft.match(/@(\S*)$/);
      if (m) {
        const hit = ['all', ...this.hub.order].find((id) => id.startsWith(m[1]) && id !== m[1]);
        if (hit) this.draft = this.draft.slice(0, this.draft.length - m[1].length) + hit + ' ';
      }
    } else if (!d.startsWith('\x1b')) this.draft += d.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    this.schedule();
  }

  target(): { to: string; text: string } {
    const m = this.draft.match(/^\s*@(\S+)\s*([\s\S]*)$/);
    if (!m) return { to: this.hub.focus, text: this.draft.trim() };
    const id = m[1].toLowerCase();
    return { to: id === 'herkes' ? 'all' : m[1], text: m[2].trim() };
  }

  send() {
    const { to, text } = this.target();
    if (!text) return;
    if (to !== 'all' && !this.hub.agents.has(to)) return this.flash(`agent yok: @${to}`);
    try { this.hub.post('user', to, text); this.draft = ''; }
    catch (e: any) { this.flash(e.message); }
  }

  async answerSelected(choice: Choice, id = this.pending[this.approvalSel]?.id) {
    const ap = this.pending.find((x) => x.id === id);
    if (!ap) return this.flash('izin bekleyen yok');
    if (!ap.prompt) { this.hub.setFocus(ap.id); return this.flash(`${ap.id}: soru okunamadı, terminalde yanıtla`); }
    try {
      const picked = await this.hub.answer(ap.id, choice, ap.prompt.key);
      this.event(ap.id, choice === 'no' ? '✗' : '✓', choice === 'no' ? STATUS_STYLE.blocked[1] : MARK, `izin: ${picked}`, ap.prompt.body[0] ?? ap.prompt.title);
    } catch (e: any) { this.flash(e.message); }
    this.schedule();
  }

  openPicker(role: Role) {
    if (role === 'orchestrator' && this.hub.orchestratorId) return this.hub.setFocus(this.hub.orchestratorId);
    this.mode = 'pick';
    this.pickRole = role;
    this.pickIdx = 0;
    this.schedule();
  }

  pickKey(d: string) {
    const n = this.hub.cfg.profiles.length;
    if (d === '\x1b[A' || d === '\x1bOA' || d === 'k') this.pickIdx = (this.pickIdx - 1 + n) % n;
    else if (d === '\x1b[B' || d === '\x1bOB' || d === 'j' || d === '\t') this.pickIdx = (this.pickIdx + 1) % n;
    else if (d === '\r' || d === '\n' || d === ' ') return this.choose(this.pickIdx);
    else if (/^[1-9]$/.test(d) && Number(d) <= n) return this.choose(Number(d) - 1);
    else if (d === '\x1b' || d === 'q' || d === PREFIX || d === '\x03') this.mode = 'normal';
    this.schedule();
  }

  choose(i: number) {
    const hub = this.hub;
    const p = hub.cfg.profiles[i];
    const role = this.pickRole === 'orchestrator' && hub.orchestratorId ? 'manual' : this.pickRole;
    this.mode = 'normal';
    if (p) {
      try { hub.setFocus(hub.spawn({ profile: p.id, role }).id); }
      catch (e: any) { this.flash(e.message); }
    }
    this.schedule();
  }

  // b: SGR button byte, x/y: 0-based screen cell, press: 'M' vs 'm'
  mouse(b: number, x: number, y: number, press: boolean) {
    const wheel = (b & 64) !== 0, motion = (b & 32) !== 0, btn = b & 3;
    const click = press && !wheel && !motion && btn === 0;
    const inside = (r: { x: number; y: number; w: number; h: number }, px = x, py = y) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;

    if (this.mode === 'pick') {
      if (!click) return;
      const h = this.pickHits.find((r) => r.y === y && x >= r.x0 && x < r.x1);
      if (h) return this.choose(h.idx);
      if (!this.pickBox || !inside(this.pickBox)) { this.mode = 'normal'; this.schedule(); }
      return;
    }
    if (this.boardBox && inside(this.boardBox)) return; // panel swallows clicks
    if (this.approvalsBox && inside(this.approvalsBox)) {
      if (!click) return;
      const h = this.approvalHits.find((r) => r.y === y && x >= r.x0 && x < r.x1);
      if (h?.choice) void this.answerSelected(h.choice, h.id);
      else if (h) { this.approvalSel = Math.max(0, this.pending.findIndex((p) => p.id === h.id)); this.hub.setFocus(h.id); }
      return;
    }

    const L = this.geo;
    if (!L) return;
    // feed column: wheel scrolls history
    if (L.fw && x >= L.fx && x < L.fx + L.fw) {
      if (wheel) { this.feedScroll = Math.max(0, this.feedScroll + (btn === 0 ? 3 : -3)); this.schedule(); }
      return;
    }
    // graph: bubbles are clickable
    const inGraph = L.mode === 'cols' ? x >= L.gx && x < L.gx + L.gw : y < L.paneTop;
    if (inGraph) {
      if (!click) return;
      const h = this.hits.find((r) => inside(r, x - L.gx, y))?.hit;
      if (!h) return;
      if (h.kind === 'agent') this.hub.setFocus(h.id);
      else this.openPicker(h.kind === 'add-orch' ? 'orchestrator' : 'manual');
      return;
    }
    // composer: a click focuses it; a click in the chat gives the keyboard back to the agent
    if ((y === L.cy || y === L.cy + 1) && x >= L.px && x < L.px + L.pw) { if (click) { this.composing = true; this.schedule(); } return; }
    if (click && this.composing) { this.composing = false; this.schedule(); }
    // chat pane: forward when the agent asked for mouse reports, otherwise swallow
    const a = this.hub.agents.get(this.hub.focus);
    const row = y - L.paneTop, col = x - L.px;
    if (!a || a.exitCode !== null || row < 0 || row >= L.P || col < 0 || col >= L.pw || a.term.modes.mouseTrackingMode === 'none') return;
    const ms = (a.term as any)._core?.coreMouseService;
    if (!ms) return;
    let button: number, action: number;
    if (wheel) { if (btn > 1) return; button = 4; action = btn === 0 ? 0 : 1; } // 4=wheel, 0=up 1=down
    else if (motion) { button = btn; action = 32; }
    else { button = btn; action = press ? 1 : 0; }
    ms.triggerMouseEvent({ col, row, button, action, ctrl: (b & 16) !== 0, alt: (b & 8) !== 0, shift: (b & 4) !== 0 });
  }

  // ── layout ───────────────────────────────────────────────────
  layout(W: number, H: number): Layout {
    const Hb = Math.max(4, H - 1); // body rows above the status bar
    if (W < 100) {
      const p = this.plan(W, H, false);
      const P = Math.max(1, H - p.G - 4);
      return { mode: 'stack', fx: 0, fw: 0, gx: 0, gw: W, px: 0, pw: W, paneTop: p.G + 1, P, cy: p.G + 1 + P, p };
    }
    const { fw, gw, pw } = columnWidths(W, this.chatShare, this.feedHidden);
    const gx = fw ? fw + 1 : 0;
    return { mode: 'cols', fx: 0, fw, gx, gw, px: gx + gw + 1, pw, paneTop: 1, P: Hb - 3, cy: Hb - 2, p: this.plan(gw, Hb, true) };
  }

  glyph(a: Agent) {
    if (a.status === 'working') return SPINNER[Math.floor(this.now / FRAME_MS + hash(a.id)) % SPINNER.length];
    if (a.status === 'blocked') return Math.floor(this.now / 450) % 2 ? '!' : ' ';
    return STATUS_STYLE[a.status][0];
  }
  label(a: Agent) {
    const l = STATUS_STYLE[a.status][2];
    return a.status === 'working' ? l + ['   ', '.  ', '.. ', '...'][Math.floor(this.now / 400) % 4] : l;
  }
  marks(a: Agent) {
    const mail = a.inbox.filter((m) => !m.delivered).length;
    const note = this.hub.boardUnread(a.id);
    const got = this.now - (this.arrivedAt.get(a.id) ?? 0) < 700;
    return (a.unread ? ' ✓' : '') + (mail || got ? ` ✉${mail || ''}` : '') + (note ? ` ▤${note}` : '');
  }

  // Border colour with life: fade in when born, breathe while working, blink when blocked, glow on mail.
  tint(a: Agent | undefined, base: RGB, focus: boolean): string {
    const now = this.now;
    let c = base, f = 1;
    if (a) {
      const born = this.bornAt.get(a.id);
      if (born !== undefined && now - born < 800) c = mix(BG_RGB, c, (now - born) / 800);
      if (a.status === 'working' || a.status === 'starting') f = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(now / 320 + (hash(a.id) % 7)));
      if (a.status === 'blocked' && Math.floor(now / 450) % 2) c = RED;
      if (a.status === 'exited') f = 0.45;
      const got = this.arrivedAt.get(a.id);
      if (got !== undefined && now - got < 700) c = mix(WHITE, c, (now - got) / 700);
    }
    return (focus ? '1;' : '') + fg(c, f);
  }

  boardPanel(W: number, H: number, G: number): { c: Canvas; x: number; y: number } {
    const notes = this.hub.board.slice(-10);
    const L = this.geo;
    const w = L.mode === 'cols' ? clamp(L.gw - 2, 20, 110) : clamp(W - 4, 20, 110);
    const h = clamp(notes.length + 4, 5, Math.max(5, H - G - 3));
    const x = L.mode === 'cols' ? L.gx + 1 : (W - w - 1 >= 0 ? W - w - 1 : 0), y = G + 1;
    const c = new Canvas(w, h);
    const bs = `0;1;${GOLD}`, bg = ';48;5;234';
    c.put(0, 0, '╭' + '─'.repeat(w - 2) + '╮', bs);
    c.put(2, 0, ` Ortak kutu (${this.hub.board.length}) `, bs);
    for (let i = 1; i < h - 1; i++) { c.put(0, i, '│', bs); c.put(1, i, ' '.repeat(w - 2), `0${bg}`); c.put(w - 1, i, '│', bs); }
    const shown = notes.slice(-(h - 4));
    if (!shown.length) c.segs(2, 1, w - 4, [['henüz not yok — coban post all "..."', DIM]], bg, false);
    shown.forEach((m, i) => {
      const col = hex(this.hub.agents.get(m.from)?.profile.color);
      c.segs(2, 1 + i, w - 4, [[hhmm(m.ts) + ' ', DIM], [m.from, `1;${col}`], [' ' + flat(m.text), '39']], bg, false);
    });
    c.segs(2, h - 2, w - 4, [['^b m kapat', DIM]], bg, false);
    c.put(0, h - 1, '╰' + '─'.repeat(w - 2) + '╯', bs);
    this.boardBox = { x, y, w, h };
    return { c, x, y };
  }

  workerLines(a: Agent, level: Level): Seg[][] {
    const [, color] = STATUS_STYLE[a.status];
    const pc = hex(a.profile.color);
    const id: Seg = [' ' + a.id, (a.id === this.hub.focus ? '1;' : '') + (level === 'mini' ? pc : '39')];
    const head: Seg[] = [[this.glyph(a), color], id, [this.marks(a), MARK]];
    if (level === 'mini') return [head];
    if (level === 'compact') return [[...head, [' ' + a.profile.title, pc]]];
    const st = this.stats.get(a.id);
    const tok: Seg[] = st ? [[' · ' + fmtTokens(st.tokens) + (st.remainPct === undefined ? '' : ` · %${Math.round(st.remainPct * 100)}`), DIM]] : [];
    return [head, [[a.profile.title, pc], [' · ' + this.label(a), DIM], ...tok]];
  }

  // Width a worker bubble needs, sized for its longest status label so bubbles don't jitter.
  workerWidth(a: Agent, level: Level): number {
    const head = 2 + a.id.length + 6;
    if (level === 'mini') return head;
    if (level === 'compact') return head + 1 + a.profile.title.length;
    return Math.max(head, a.profile.title.length + 3 + Math.max(...Object.values(STATUS_STYLE).map(([, , l]) => l.length)) + 3 + (a.profile.cmd.startsWith('claude') ? 13 : 0));
  }

  orchLines(a: Agent | undefined, compact: boolean): Seg[][] {
    if (!a) return compact ? [[['+ ', '1;38;5;214'], ['ORKESTRATÖR', `1;${GOLD}`]]] : [[['ORKESTRATÖR', `1;${GOLD}`]], [['+', '1;38;5;214']]];
    const [, color] = STATUS_STYLE[a.status];
    const main: Seg[] = [[this.glyph(a), color], [' ' + a.profile.title.replace(' ', ' · '), `1;${hex(a.profile.color)}`], [this.marks(a), MARK]];
    if (compact) return [[['★ ', GOLD], ...main]];
    return [[['ORKESTRATÖR', GOLD]], [...main, [' · ' + this.label(a), DIM]]];
  }

  addLines(compact: boolean): Seg[][] {
    return compact ? [[['+ işçi', MARK]]] : [[['+', `1;${MARK}`]], [['işçi', DIM]]];
  }

  // full: the graph owns a whole column (centred vertically), otherwise it is a band above the chat
  plan(W: number, H: number, full: boolean): Plan {
    const hub = this.hub;
    const workers = hub.order.map((id) => hub.agents.get(id)!).filter((a) => a.role !== 'orchestrator');
    const n = workers.length + (hub.order.length ? 1 : 0); // + the "add worker" bubble
    const capG = full ? H - 1 : Math.max(3, Math.min(Math.max(7, Math.round(H * 0.3)), H - 8));
    const cx = Math.floor(W / 2);
    let p: Plan | undefined;
    for (const level of ['full', 'compact', 'mini'] as Level[]) {
      const bh = level === 'full' ? 4 : 3;
      const widest = Math.max(0, ...workers.map((a) => this.workerWidth(a, level)));
      const bw = Math.min(Math.max(1, W - 2), clamp(widest + 4, level === 'full' ? 16 : 10, level === 'full' ? 30 : 26));
      const pitch = bw + 1;
      const nL = Math.floor(cx / pitch), nR = Math.floor((W - 1 - cx) / pitch);
      const perRow = Math.max(1, nL + nR);
      const want = Math.ceil(n / perRow);
      const fitRows = Math.max(0, Math.floor((capG - bh) / (bh + 1)));
      p = { G: 0, level, bh, bw, perRow, nL, nR, rows: Math.min(want, fitRows), items: [] };
      // in a narrow column prefer smaller bubbles side by side over a single-file stack
      if (want <= fitRows && (perRow >= Math.min(2, n) || level === 'mini')) break;
    }
    p = p!;
    const cap = p.rows * p.perRow;
    const items: Item[] = workers.map((a) => ({ kind: 'agent', a }));
    if (n > cap && cap >= 2) {
      const shown = items.slice(0, cap - 2);
      const fi = workers.findIndex((a) => a.id === hub.focus);
      if (fi >= cap - 2 && shown.length) shown[shown.length - 1] = items[fi]; // keep the focused bubble visible
      const visible = new Set(shown.map((it) => (it as { a: Agent }).a.id));
      const hidden = workers.filter((a) => !visible.has(a.id));
      p.items = [...shown, { kind: 'more', n: hidden.length, first: hidden[0].id }, { kind: 'add' }];
    } else p.items = n ? [...items, { kind: 'add' } as Item].slice(0, cap) : [];
    const used = p.bh + p.rows * (p.bh + 1);
    p.G = full ? capG : Math.min(capG, Math.max(7, used));
    return p;
  }

  graph(W: number, p: Plan, full: boolean): Canvas {
    const hub = this.hub;
    const c = new Canvas(W, p.G + 1);
    this.hits = [];
    this.nodes.clear();
    const compact = p.bh === 3;
    const cx = Math.floor(W / 2);
    const used = p.bh + p.rows * (p.bh + 1);
    const top = Math.max(0, Math.floor(((full ? p.G + 1 : p.G) - used) / 2));
    const num = (id: string) => String(hub.order.indexOf(id) + 1);

    // root: the orchestrator (double-line gold box)
    const orch = hub.agents.get(hub.orchestratorId);
    const ol = this.orchLines(orch, compact);
    const ow = clamp(Math.max(...ol.map(segLen)) + 6, compact ? 18 : 21, W);
    const ox = clamp(cx - Math.floor(ow / 2), 0, W - ow);
    const ofocus = !!orch && orch.id === hub.focus;
    this.box(c, ox, top, ow, p.bh, ol, {
      style: 'double', color: this.tint(orch, GOLD_RGB, ofocus), bg: ofocus ? ';48;5;236' : '',
      label: orch ? num(orch.id) : '', hit: orch ? { kind: 'agent', id: orch.id } : { kind: 'add-orch' },
    });
    this.orchJoint = [cx, top + p.bh - 1];

    if (p.rows && p.items.length) {
      c.put(cx, top + p.bh - 1, '╤', `0;${ofocus ? '1;' : ''}${GOLD}`);
      const pitch = p.bw + 1;
      let prevY = top + p.bh - 1;
      for (let r = 0; r < p.rows; r++) {
        const row = p.items.slice(r * p.perRow, (r + 1) * p.perRow);
        if (!row.length) break;
        const last = (r + 1) * p.perRow >= p.items.length;
        const busY = top + p.bh + r * (p.bh + 1);
        let xs: number[];
        if (last) { // final row: centred under the trunk
          const blockW = row.length * pitch - 1;
          const start = clamp(cx - Math.floor(blockW / 2), 0, Math.max(0, W - blockW));
          xs = row.map((_, i) => start + i * pitch);
        } else { // the trunk passes between the left and right halves
          const kL = Math.min(p.nL, Math.ceil(row.length / 2));
          xs = row.map((_, i) => (i < kL ? cx - 1 - p.bw - (kL - 1 - i) * pitch : cx + 2 + (i - kL) * pitch));
        }
        const anchors = xs.map((x) => x + Math.floor(p.bw / 2));
        c.vline(cx, prevY, busY);
        c.hline(busY, Math.min(anchors[0], cx), Math.max(anchors[anchors.length - 1], cx));
        row.forEach((it, i) => {
          const x = xs[i], y = busY + 1, ax = anchors[i];
          c.vline(ax, busY, y);
          if (it.kind === 'agent') {
            const a = it.a, focus = a.id === hub.focus;
            this.nodes.set(a.id, { ax, ay: y, bus: busY });
            this.box(c, x, y, p.bw, p.bh, this.workerLines(a, p.level), {
              style: focus ? 'heavy' : 'round', color: this.tint(a, rgbOf(a.profile.color) ?? [200, 200, 200], focus),
              bg: focus ? ';48;5;236' : '', label: num(a.id), hit: { kind: 'agent', id: a.id }, joint: ax,
            });
          } else if (it.kind === 'more') {
            this.box(c, x, y, p.bw, p.bh, [[[p.level === 'mini' ? `… +${it.n}` : `… +${it.n} işçi`, DIM]]], {
              style: 'dash', color: DIM, bg: '', label: '', hit: { kind: 'agent', id: it.first }, joint: ax,
            });
          } else {
            const aw = compact ? 10 : 8;
            this.box(c, x + Math.floor((p.bw - aw) / 2), y, aw, p.bh, this.addLines(compact), {
              style: 'dash', color: DIM, bg: '', label: '', hit: { kind: 'add-worker' }, joint: ax,
            });
          }
        });
        prevY = busY;
      }
    }
    this.drawPackets(c);

    if (full) {
      if (!hub.orchestratorId) c.segs(0, Math.min(p.G, top + p.bh + 1), W, [['+ baloncuğuna tıkla ya da Enter\'a bas', DIM]], '');
      return c;
    }
    // stacked layout: separator + title of the chat below
    c.put(0, p.G, '─'.repeat(W), SEP);
    const f = hub.agents.get(hub.focus);
    if (f) {
      c.put(1, p.G, ' ', '0');
      let x = 2;
      for (const [t, s] of this.paneTitle(f)) { c.put(x, p.G, t, `0;${s}`); x += [...t].length; }
    } else if (!hub.orchestratorId) {
      c.put(2, p.G, ' ORKESTRATÖR baloncuğundaki + işaretine tıkla (veya Enter) ', `0;${DIM}`);
    }
    return c;
  }

  // Path along the drawn edges from the orchestrator's bottom joint down to an agent's top joint.
  pathTo(id: string): Pt[] | null {
    if (id === this.hub.orchestratorId) return [this.orchJoint];
    const n = this.nodes.get(id);
    if (!n) return null;
    const [cx, oy] = this.orchJoint;
    const pts: Pt[] = [];
    for (let y = oy; y <= n.bus; y++) pts.push([cx, y]);
    const dx = Math.sign(n.ax - cx);
    for (let x = cx + dx; dx && x !== n.ax + dx; x += dx) pts.push([x, n.bus]);
    for (let y = n.bus + 1; y <= n.ay; y++) pts.push([n.ax, y]);
    return pts;
  }

  drawPackets(c: Canvas) {
    const now = this.now;
    const live: Packet[] = [];
    for (const pk of this.packets) {
      const a = this.pathTo(pk.from), b = this.pathTo(pk.to);
      if (!a || !b) continue;                       // endpoint not on screen (closed / folded into "+N")
      let k = 0;                                    // shared prefix (the common trunk) is not walked twice
      while (k < a.length && k < b.length && a[k][0] === b[k][0] && a[k][1] === b[k][1]) k++;
      const path = [...a.slice(Math.max(0, k - 1)).reverse(), ...b.slice(k)];
      if (!pk.dur) pk.dur = clamp(path.length * 28, 380, 1400);
      const t = (now - pk.t0) / pk.dur;
      if (t < 0) { live.push(pk); continue; }
      if (t >= 1) { this.arrivedAt.set(pk.to, now); continue; }
      const i = Math.floor(t * (path.length - 1));
      const tail: [string, number][] = [['●', 1], ['•', 0.7], ['·', 0.45]];
      tail.forEach(([g, f], j) => { const q = path[i - j]; if (q) c.put(q[0], q[1], g, `0;1;${fg(pk.color, f)}`); });
      live.push(pk);
    }
    this.packets = live;
  }

  box(c: Canvas, x: number, y: number, w: number, h: number, lines: Seg[][],
      o: { style: 'round' | 'heavy' | 'double' | 'dash'; color: string; bg: string; label: string; hit: Hit; joint?: number }) {
    const k = {
      round: ['╭', '╮', '╰', '╯', '─', '│', '┸'],
      heavy: ['┏', '┓', '┗', '┛', '━', '┃', '┻'],
      double: ['╔', '╗', '╚', '╝', '═', '║', '╨'],
      dash: ['╭', '╮', '╰', '╯', '┄', '┆', '┸'],
    }[o.style];
    const bs = `0;${o.color}`;
    c.put(x, y, k[0] + k[4].repeat(Math.max(0, w - 2)) + k[1], bs);
    if (o.label) c.put(x + 2, y, o.label, `0;${DIM}`);
    if (o.joint !== undefined) c.put(o.joint, y, k[6], bs);
    const inner = h - 2;
    const start = Math.floor((inner - lines.length) / 2);
    for (let i = 0; i < inner; i++) {
      c.put(x, y + 1 + i, k[5], bs);
      c.put(x + 1, y + 1 + i, ' ', `0${o.bg}`);
      c.segs(x + 2, y + 1 + i, w - 4, lines[i - start] ?? [], o.bg);
      c.put(x + w - 2, y + 1 + i, ' ', `0${o.bg}`);
      c.put(x + w - 1, y + 1 + i, k[5], bs);
    }
    c.put(x, y + h - 1, k[2] + k[4].repeat(Math.max(0, w - 2)) + k[3], bs);
    this.hits.push({ x, y, w, h, hit: o.hit });
  }

  picker(W: number, H: number): { c: Canvas; x: number; y: number } {
    const ps = this.hub.cfg.profiles;
    const title = this.pickRole === 'orchestrator' ? ' Orkestratör seç ' : ' Yeni işçi ';
    const rows: Seg[][] = ps.map((p, i) => [[`${i + 1}  `, DIM], ['● ', hex(p.color)], [p.title, `1;${hex(p.color)}`], [`  ${p.id}`, DIM]]);
    const footer: Seg[] = [['↑↓ · 1-9 · enter · esc', DIM]];
    const w = clamp(Math.max(segLen(footer), ...rows.map(segLen), title.length) + 6, 30, W);
    const h = ps.length + 4;
    const x = Math.floor((W - w) / 2), y = clamp(Math.floor((H - 1 - h) / 2), 0, Math.max(0, H - 1 - h));
    const c = new Canvas(w, h);
    const bs = `0;1;${GOLD}`, bg = ';48;5;234';
    c.put(0, 0, '╭' + '─'.repeat(w - 2) + '╮', bs);
    c.put(2, 0, title, `0;1;${GOLD}`);
    for (let i = 1; i < h - 1; i++) { c.put(0, i, '│', bs); c.put(1, i, ' '.repeat(w - 2), `0${bg}`); c.put(w - 1, i, '│', bs); }
    this.pickHits = [];
    rows.forEach((segs, i) => {
      const sel = i === this.pickIdx;
      const rbg = sel ? ';48;5;238' : bg;
      c.put(1, 1 + i, ' '.repeat(w - 2), `0${rbg}`);
      c.put(2, 1 + i, sel ? '▸' : ' ', `0;1;${GOLD}${rbg}`);
      c.segs(4, 1 + i, w - 6, segs, rbg, false);
      this.pickHits.push({ y: y + 1 + i, x0: x + 1, x1: x + w - 1, idx: i });
    });
    c.segs(2, h - 2, w - 4, footer, bg, false);
    c.put(0, h - 1, '╰' + '─'.repeat(w - 2) + '╯', bs);
    this.pickBox = { x, y, w, h };
    return { c, x, y };
  }

  // ── feed: who said what to whom, plus lifecycle events ───────
  feed(w: number, h: number): Canvas {
    const c = new Canvas(w, h);
    const hub = this.hub, now = this.now;
    const name = (id: string) => id === 'all' ? ['ortak kutu', `1;${GOLD}`] as Seg : id === 'user' ? ['sen', '1;38;5;117'] as Seg
      : [id, `1;${hex(hub.agents.get(id)?.profile.color)}`] as Seg;
    const wrap = (text: string, width: number, max: number): string[] => {
      const lines: string[] = [];
      for (const para of text.split('\n')) {
        let cur = '';
        for (const word of para.split(/\s+/).filter(Boolean)) {
          for (let wd = word; wd.length;) {
            const room = width - (cur ? cur.length + 1 : 0);
            if (wd.length <= room) { cur = cur ? cur + ' ' + wd : wd; wd = ''; }
            else if (!cur) { lines.push(wd.slice(0, width)); wd = wd.slice(width); }
            else { lines.push(cur); cur = ''; }
          }
        }
        if (cur) lines.push(cur);
        if (lines.length > max) break;
      }
      return lines.length > max ? [...lines.slice(0, max - 1), fit(lines[max - 1], width - 1) + '…'] : lines;
    };
    type Row = { segs: Seg[]; bg: string };
    const rows: Row[] = [];
    const tw = Math.max(8, w - 4);
    const items: ({ ts: number; m: Msg } | { ts: number; e: FeedEvent })[] = [
      ...hub.log.slice(-150).map((m) => ({ ts: m.ts, m })),
      ...this.events.slice(-150).map((e) => ({ ts: e.ts, e })),
    ].sort((a, b) => a.ts - b.ts);
    for (const it of items) {
      const fresh = now - it.ts < 1600;
      const bg = fresh ? `;48;5;${236 + Math.round((1 - (now - it.ts) / 1600) * 2)}` : '';
      if ('m' in it) {
        const m = it.m;
        let text = m.text;
        if (text.startsWith('[coban] Sen coban')) text = '(işçi talimatı) ' + text.replace(/^[\s\S]*?GÖREV:\s*/, '');
        text = text.replace(/\n\nİLGİLİ KOD[\s\S]*$/, ' [+ ilgili kod]');
        rows.push({ segs: [[hhmm(m.ts) + ' ', DIM], name(m.from), [' → ', DIM], name(m.to)], bg });
        for (const l of wrap(text, tw, 6)) rows.push({ segs: [['  ' + l, m.to === 'all' ? '38;5;223' : '38;5;252']], bg });
      } else {
        const e = it.e;
        rows.push({ segs: [[hhmm(e.ts) + ' ', DIM], [e.glyph + ' ', e.color], [e.id, `1;${hex(hub.agents.get(e.id)?.profile.color)}`], [' ' + e.text, '3;' + DIM]], bg });
        if (e.detail) for (const l of wrap(e.detail, tw, 2)) rows.push({ segs: [['  ' + l, DIM]], bg });
      }
      rows.push({ segs: [], bg: '' });
    }
    // header
    c.segs(0, 0, w, [[' ◆ ', GOLD], ['Konuşmalar', `1;${GOLD}`], [`  ${hub.log.length} mesaj`, DIM]], '', false);
    c.put(0, 1, '─'.repeat(w), SEP);
    const room = h - 2;
    const maxScroll = Math.max(0, rows.length - room);
    this.feedScroll = Math.min(this.feedScroll, maxScroll);
    const end = rows.length - this.feedScroll;
    const view = rows.slice(Math.max(0, end - room), end);
    if (!items.length) c.segs(1, 3, w - 2, [['agent\'lar konuşunca burada görünür', DIM]], '', false);
    view.forEach((r, i) => c.segs(1, 2 + i, w - 1, r.segs, r.bg, false));
    if (this.feedScroll) c.segs(0, h - 1, w, [[` ↓ ${this.feedScroll} satır yukarıdasın · tekerlekle in `, '30;48;5;214']], '', false);
    return c;
  }

  // ── approval inbox ───────────────────────────────────────
  approvalsPanel(L: Layout, H: number): { c: Canvas; x: number; y: number } | undefined {
    this.approvalHits = [];
    if (!this.pending.length || (L.mode === 'stack' && !this.showApprovals)) return undefined;
    this.approvalSel = Math.min(this.approvalSel, this.pending.length - 1);
    const x = L.gx + 1, w = Math.max(24, L.gw - 2);
    const maxItems = Math.max(1, Math.floor((H - 5) / 3));
    const shown = this.pending.slice(0, maxItems);
    const h = 3 + shown.length * 3 + (this.pending.length > shown.length ? 1 : 0);
    const y = L.mode === 'cols' ? Math.max(0, H - 1 - h) : L.paneTop;
    const c = new Canvas(w, h);
    const blink = Math.floor(this.now / 600) % 2 === 0;
    const bs = `0;1;${blink ? '38;5;203' : '38;5;167'}`, bg = ';48;5;234';
    c.put(0, 0, '╭' + '─'.repeat(w - 2) + '╮', bs);
    c.put(2, 0, ` ! İZİN BEKLEYENLER (${this.pending.length}) `, bs);
    for (let i = 1; i < h - 1; i++) { c.put(0, i, '│', bs); c.put(1, i, ' '.repeat(w - 2), `0${bg}`); c.put(w - 1, i, '│', bs); }
    shown.forEach((ap, i) => {
      const r = 1 + i * 3, sel = i === this.approvalSel, rbg = sel ? ';48;5;237' : bg;
      const a = this.hub.agents.get(ap.id);
      const p = ap.prompt;
      for (let k = 0; k < 3; k++) c.put(1, r + k, ' '.repeat(w - 2), `0${rbg}`);
      c.segs(2, r, w - 4, [[sel ? '▸ ' : '  ', `1;${GOLD}`], [ap.id, `1;${hex(a?.profile.color)}`], [` · ${ap.title} · `, DIM], [p?.title ?? 'izin', '1;39']], rbg, false);
      c.segs(4, r + 1, w - 6, [[p ? (p.body.length ? p.body.join(' · ') : p.question) : 'soru okunamadı — tıkla, terminalde yanıtla', p ? '38;5;223' : DIM]], rbg, false);
      this.approvalHits.push({ x0: x + 1, x1: x + w - 1, y: y + r, id: ap.id }, { x0: x + 1, x1: x + w - 1, y: y + r + 1, id: ap.id });
      if (!p) return;
      // buttons: the exact option text, so "always" never hides what it grants
      let bx = 4;
      const pick = (choice: Choice, key: string, color: string) => {
        const idx = p.kind === 'yn' ? (choice === 'always' ? -1 : 0) : pickOption(p, choice); // same rule as the keys sent
        if (idx < 0) return;
        const label = p.kind === 'yn' ? (choice === 'no' ? 'hayır' : 'evet') : p.options[idx].label;
        const room = w - 2 - bx; if (room < 8) return;
        const text = fit(`[${key}] ${label}`, Math.min(room, choice === 'always' ? 60 : 16)).trimEnd();
        c.segs(bx, r + 2, text.length, [[text, color]], rbg, false);
        this.approvalHits.push({ x0: x + bx, x1: x + bx + text.length, y: y + r + 2, id: ap.id, choice });
        bx += text.length + 2;
      };
      pick('yes', 'y', `1;${MARK}`); pick('no', 'r', '1;38;5;203'); pick('always', 'a', '38;5;179'); // the long label goes last
    });
    if (this.pending.length > shown.length) c.segs(2, h - 2, w - 4, [[`+${this.pending.length - shown.length} daha · ^b i ile sırayla`, DIM]], bg, false);
    c.put(0, h - 1, '╰' + '─'.repeat(w - 2) + '╯', bs);
    c.put(2, h - 1, ' ^b y onayla · a hep · r reddet · i sıradaki ', `0;${DIM}`);
    this.approvalsBox = { x, y, w, h };
    return { c, x, y };
  }

  composer(w: number): Canvas {
    const c = new Canvas(w, 2);
    const { to } = this.target();
    const known = to === 'all' || this.hub.agents.has(to);
    const toSeg: Seg = to === 'all' ? ['ortak kutu', `1;${GOLD}`] : [to || '—', known ? `1;${hex(this.hub.agents.get(to)?.profile.color)}` : '1;38;5;203'];
    c.put(0, 0, '─'.repeat(w), SEP);
    c.segs(1, 0, w - 2, [[' sen → ', DIM], toSeg, [this.composing ? '  · enter gönder · esc çık · tab @tamamla ' : ' ', DIM]], '', false);
    const bg = this.composing ? ';48;5;236' : '';
    const flatDraft = this.draft.replace(/\n/g, ' ⏎ ');
    if (!this.draft && !this.composing) c.segs(0, 1, w, [[' › ', DIM], ['@agent ile birine, @all ile herkese yaz… (^b c ya da tıkla)', `3;${DIM}`]], bg, false);
    else {
      const room = w - 4;
      const vis = flatDraft.length > room ? '…' + flatDraft.slice(-(room - 1)) : flatDraft;
      const m = vis.match(/^(@\S+)([\s\S]*)$/);
      c.segs(0, 1, w, [[' › ', `1;${GOLD}`], ...(m ? [[m[1], toSeg[1]], [m[2], '39']] as Seg[] : [[vis, '39']] as Seg[])], bg, false);
    }
    return c;
  }

  paneTitle(f: Agent): Seg[] {
    return [[this.glyph(f), STATUS_STYLE[f.status][1]], [' ' + f.id, '1'], [' · ', DIM], [f.profile.title, hex(f.profile.color)],
      [f.model ? ' · ' + f.model.replace(/^claude-/, '') : '', DIM], [' · ' + STATUS_STYLE[f.status][2], DIM]];
  }

  // ── render ───────────────────────────────────────────────────
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.render(); }, 16);
  }

  render() {
    const hub = this.hub;
    const W = out.columns, H = out.rows;
    this.now = Date.now();
    this.settleDone();
    const L = this.layout(W, H);
    this.geo = L;
    if (hub.size.cols !== L.pw || hub.size.rows !== L.P) hub.resizeAll(L.pw, L.P);

    const full = L.mode === 'cols';
    const graph = this.graph(L.gw, L.p, full);
    const feed = L.fw ? this.feed(L.fw, H - 1) : undefined;
    const focus = hub.agents.get(hub.focus);
    let head: Canvas | undefined;
    if (full) {
      head = new Canvas(L.pw, 1);
      if (focus) head.segs(0, 0, L.pw, [[' ▍', this.tint(focus, rgbOf(focus.profile.color) ?? GOLD_RGB, false)], ['SOHBET ', `1;${DIM}`], ...this.paneTitle(focus)], ';48;5;235', false);
      else head.segs(0, 0, L.pw, [[' ▍SOHBET', `1;${DIM}`]], ';48;5;235', false);
    }
    const ov = this.mode === 'pick' ? this.picker(W, H) : undefined;
    if (!ov) this.pickBox = undefined;
    const bp = this.showBoard && !ov ? this.boardPanel(W, H, full ? 0 : L.p.G) : undefined;
    if (!bp) this.boardBox = undefined;
    this.pending = hub.approvals();
    if (!this.pending.length) this.showApprovals = false;
    const ap = !ov ? this.approvalsPanel(L, H) : undefined;
    if (!ap) this.approvalsBox = undefined;
    const comp = this.composer(L.pw);
    const chatRow = (y: number, a: number, b: number) =>
      y === L.cy || y === L.cy + 1 ? comp.row(y - L.cy, a, b) : this.paneRow(focus, y - L.paneTop, L.P, L.pw, a, b);

    // one screen row, clipped to [x0, x1): each column renders only its own slice
    const base = (y: number, x0: number, x1: number): string => {
      if (!full) return y <= L.p.G ? graph.row(y, x0, x1) : chatRow(y, x0, x1);
      const cols: [number, number, (a: number, b: number) => string][] = [];
      if (feed) cols.push([L.fx, L.fw, (a, b) => feed.row(y, a, b)], [L.fx + L.fw, 1, () => `\x1b[${SEP}m│\x1b[0m`]);
      cols.push([L.gx, L.gw, (a, b) => graph.row(y, a, b)], [L.gx + L.gw, 1, () => `\x1b[${SEP}m│\x1b[0m`]);
      cols.push([L.px, L.pw, (a, b) => (y === 0 ? head!.row(0, a, b) : chatRow(y, a, b))]);
      let s = '';
      for (const [cx, cw, fn] of cols) {
        const a = Math.max(x0, cx), b = Math.min(x1, cx + cw);
        if (a < b) s += fn(a - cx, b - cx);
      }
      return s;
    };
    const lines: string[] = [];
    const overlays = [ov, bp, ap].filter((o): o is { c: Canvas; x: number; y: number } => !!o);
    for (let y = 0; y < H - 1; y++) {
      // overlays covering this row, left to right; an overlay starting inside an earlier one is skipped
      const here = overlays.filter((o) => y >= o.y && y < o.y + o.c.h).sort((p, q) => p.x - q.x);
      let s = '', x = 0;
      for (const o of here) {
        if (o.x < x) continue;
        s += base(y, x, o.x) + o.c.row(y - o.y);
        x = o.x + o.c.w;
      }
      lines.push(s + base(y, x, W));
    }
    lines.push(this.statusBar(W));

    let buf = '\x1b[?2026h\x1b[?25l'; // synchronized update
    for (let y = 0; y < lines.length; y++) {
      if (this.prev[y] !== lines[y]) buf += `${ESC}${y + 1};1H${lines[y]}\x1b[0m`;
    }
    this.prev = lines;

    // outer mouse mode: always clicks (1000) in SGR (1006); motion only if the focused agent wants it
    const want = focus?.term.modes.mouseTrackingMode;
    const mouse = this.selectMode ? '\x1b[?1000l\x1b[?1006l'
      : '\x1b[?1000h\x1b[?1006h' + (want === 'drag' ? '\x1b[?1002h' : want === 'any' ? '\x1b[?1003h' : '');
    if (mouse !== this.outerMouse) { buf += '\x1b[?1002l\x1b[?1003l' + mouse; this.outerMouse = mouse; }

    if (focus) {
      const appCursor = focus.term.modes.applicationCursorKeysMode;
      if (appCursor !== this.outerAppCursor) { buf += appCursor ? '\x1b[?1h' : '\x1b[?1l'; this.outerAppCursor = appCursor; }
      const b = focus.term.buffer.active;
      if (this.composing && this.mode === 'normal' && !this.prefix) {
        const n = Math.min([...this.draft.replace(/\n/g, ' ⏎ ')].length, L.pw - 4);
        buf += `${ESC}${L.cy + 2};${L.px + 4 + n}H\x1b[?25h`;
      } else if (focus.cursorVisible && this.mode === 'normal' && !this.prefix && b.cursorY < L.P && b.cursorX < L.pw) {
        buf += `${ESC}${L.paneTop + b.cursorY + 1};${L.px + b.cursorX + 1}H\x1b[?25h`;
      }
    }
    out.write(buf + '\x1b[?2026l');

    // keep frames coming only while something is moving
    if (this.animating() && !this.animPending) {
      this.animPending = true;
      setTimeout(() => { this.animPending = false; this.schedule(); }, FRAME_MS);
    }
  }

  // One pane row, clipped to columns [x0, x1) of a pane W cells wide.
  paneRow(a: Agent | undefined, y: number, P: number, W: number, x0: number, x1: number): string {
    const w = x1 - x0;
    if (w <= 0) return '';
    const plain = (s: string, sgr = '0') => `\x1b[${sgr}m${fit(s, W).slice(x0, x1)}\x1b[0m`;
    if (!a) {
      const hint = this.hub.orchestratorId ? '' : 'orkestratör seçmek için + baloncuğuna tıkla ya da Enter\'a bas';
      const pad = ' '.repeat(Math.max(0, Math.floor((W - hint.length) / 2)));
      return plain(y === Math.floor(P / 2) ? pad + hint : '', `0;${DIM}`);
    }
    if (a.status === 'exited' && y === P - 1) return plain(` süreç kapandı (kod ${a.exitCode}) — ^b x ile kaldır`, '0;7');
    const b = a.term.buffer.active;
    const line = b.getLine(b.viewportY + y);
    if (!line) return ' '.repeat(w);
    const cell = b.getNullCell();
    let s = '', last = '', col = 0;
    for (let x = 0; x < a.term.cols && col < x1; x++) {
      line.getCell(x, cell);
      const cw = cell.getWidth();
      if (cw === 0) continue;
      if (col + cw <= x0) { col += cw; continue; }
      if (col < x0 || col + cw > x1) { // wide glyph cut by the clip edge
        const n = Math.min(col + cw, x1) - Math.max(col, x0);
        s += '\x1b[0m' + ' '.repeat(n); last = '0'; col += cw; continue;
      }
      const sgr = sgrOf(cell);
      if (sgr !== last) { s += `\x1b[${sgr}m`; last = sgr; }
      s += cell.getChars() || ' ';
      col += cw;
    }
    return s + '\x1b[0m' + ' '.repeat(Math.max(0, x1 - Math.max(col, x0)));
  }

  usage: AccountUsage[] = [];
  stats = new Map<string, { tokens: number; remainPct?: number }>(); // per worker, refreshed with usage
  usageAt = 0;
  refreshUsage() {
    if (this.now - this.usageAt < USAGE_MS) return;
    this.usageAt = this.now;
    setImmediate(() => { // off the render path; hub.usage() includes limitedAt
      try { this.usage = this.hub.usage(); this.stats = this.hub.stats(); } catch { this.usage = []; }
      this.schedule();
    });
  }

  statusBar(w: number): string {
    const hub = this.hub;
    let left: string;
    if (this.showBoard) hub.markBoardRead('user'); // the open panel counts as read
    const unreadBoard = hub.boardUnread('user');
    if (this.mode === 'pick') left = ' ↑↓ / 1-9 seç · enter onayla · esc iptal ';
    else if (this.selectMode && !this.prefix) left = ' SEÇİM MODU · fareyle seç ve kopyala (⌘C) · çıkmak için ^b s ';
    else if (this.prefix) left = ' ^b → c:mesaj  y/a/r:izin  i:sıradaki  n:yeni  1-9:seç  j/k:gez  o:orkestra  m:kutu  l:konuşmalar  ←→:genişlik  s:kopyala  x:kapat  q:çık ';
    else left = ` ^b komut · ${hub.focus || '-'}${this.pending.length ? `  ! ${this.pending.length} izin bekliyor (^b y/a/r${this.geo?.mode === 'stack' ? ', ^b i' : ''})` : ''}${unreadBoard ? `  ▤${unreadBoard} ortak kutu (^b m)` : ''} `;
    const bg = this.prefix || this.mode !== 'normal' || this.selectMode ? '\x1b[0;30;48;5;214m' : '\x1b[0;38;5;250;48;5;235m';
    const right = this.notice ? ` ${this.notice} ` : '';
    const room = Math.max(0, w - right.length);
    if (room < 10) return `${bg}${fit(left, w)}\x1b[0m`;
    const l = left.length <= room ? left : fit(left, room);
    const last = hub.log.at(-1);
    const feedVisible = this.geo?.fw > 0;
    this.refreshUsage();
    const ub = this.usage.length && !this.prefix && this.mode === 'normal' && !this.selectMode ? usageBarSegs(this.usage, room - l.length - 1) : null;
    if (ub?.len) {
      const pad = room - l.length - ub.len - 1;
      const body = ub.segs.map(([t, g]) => `\x1b[${g};48;5;235m${t}`).join('');
      return `${bg}${l}\x1b[0;48;5;235m ${body}\x1b[0;38;5;244;48;5;235m${' '.repeat(Math.max(0, pad))}\x1b[0;30;48;5;223m${right}\x1b[0m`;
    }
    const mid = !feedVisible && !right && !this.prefix && this.mode === 'normal' && last ? ` ✉ ${last.from}→${last.to}: ${flat(last.text)}` : '';
    return `${bg}${l}\x1b[0;38;5;244;48;5;235m${fit(mid, room - l.length)}\x1b[0;30;48;5;223m${right}\x1b[0m`;
  }
}

function sgrOf(c: any): string {
  const p = ['0'];
  if (c.isBold()) p.push('1');
  if (c.isDim()) p.push('2');
  if (c.isItalic()) p.push('3');
  if (c.isUnderline()) p.push('4');
  if (c.isInverse()) p.push('7');
  if (c.isStrikethrough?.()) p.push('9');
  if (c.isFgRGB()) { const v = c.getFgColor(); p.push(`38;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isFgPalette()) { const v = c.getFgColor(); p.push(v < 8 ? `${30 + v}` : v < 16 ? `${82 + v}` : `38;5;${v}`); }
  if (c.isBgRGB()) { const v = c.getBgColor(); p.push(`48;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`); }
  else if (c.isBgPalette()) { const v = c.getBgColor(); p.push(v < 8 ? `${40 + v}` : v < 16 ? `${92 + v}` : `48;5;${v}`); }
  return p.join(';');
}
