import type { Agent, Msg, Role, Status } from './agent.ts';
import type { Hub } from './hub.ts';

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
  idle:     ['○', '38;5;248', 'boşta'],
  exited:   ['×', '38;5;240', 'kapandı'],
};

// Visual language borrowed from Sokratic's bubble graph: gold root, gold heavy root edges,
// nodes outlined in their own (profile) colour, centred labels.
const GOLD = '38;2;203;163;67';      // #cba343 root
const GOLD_DEEP = '38;2;184;134;42'; // #b8862a root edges
const DIM = '38;5;244';
const MARK = '38;5;114';

const hex = (h?: string) => {
  const m = h?.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? `38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}` : '39';
};
const fit = (s: string, w: number) => (w <= 0 ? '' : s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s + ' '.repeat(w - s.length));
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
    this.w = w; this.h = h;
    const n = w * h;
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
      let c = this.ch[i], g = this.sgr[i];
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

export class Tui {
  hub: Hub;
  prev: string[] = [];
  scheduled = false;
  prefix = false;
  mode: 'normal' | 'pick' = 'normal';
  pickRole: Role = 'manual';
  pickIdx = 0;
  notice = '';
  showBoard = false;
  selectMode = false;  // mouse released to the terminal so text can be selected/copied
  boardBox?: { x: number; y: number; w: number; h: number };
  noticeTimer?: NodeJS.Timeout;
  outerAppCursor = false;
  outerMouse = '';
  spin = 0;
  hits: Box[] = [];
  pickHits: { y: number; x0: number; x1: number; idx: number }[] = [];
  pickBox?: { x: number; y: number; w: number; h: number };
  geo = { G: 7, paneTop: 8, P: 20 };

  constructor(hub: Hub) {
    this.hub = hub;
    hub.on('render', (a: Agent) => { if (a.id === hub.focus) this.schedule(); });
    hub.on('change', () => this.schedule());
    hub.on('board', () => this.schedule());
    hub.on('notify', (m: Msg) => this.flash(`✉ ${m.from}: ${flat(m.text)}`, 15000));
    setInterval(() => { this.spin++; if ([...hub.agents.values()].some((a) => a.status === 'working')) this.schedule(); }, 500).unref();
  }

  get paneSize() {
    const W = out.columns, H = out.rows;
    const { G } = this.plan(W, H);
    return { cols: Math.max(20, W), rows: Math.max(3, H - G - 2) };
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
    if (d === PREFIX) { this.prefix = true; return this.schedule(); }
    if (d[0] === PREFIX) { this.prefix = true; return this.input(d.slice(1)); } // ^b and the key in one read

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
      case 's': this.selectMode = !this.selectMode; break;
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
    const inside = (r: { x: number; y: number; w: number; h: number }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

    if (this.mode === 'pick') {
      if (!click) return;
      const h = this.pickHits.find((r) => r.y === y && x >= r.x0 && x < r.x1);
      if (h) return this.choose(h.idx);
      if (!this.pickBox || !inside(this.pickBox)) { this.mode = 'normal'; this.schedule(); }
      return;
    }

    if (this.boardBox && inside(this.boardBox)) return; // panel swallows clicks
    const { G, paneTop, P } = this.geo;
    if (y <= G) {
      if (!click) return;
      const h = this.hits.find(inside)?.hit;
      if (!h) return;
      if (h.kind === 'agent') this.hub.setFocus(h.id);
      else this.openPicker(h.kind === 'add-orch' ? 'orchestrator' : 'manual');
      return;
    }

    // pane: forward when the agent asked for mouse reports, otherwise swallow
    const a = this.hub.agents.get(this.hub.focus);
    const row = y - paneTop;
    if (!a || a.exitCode !== null || row < 0 || row >= P || a.term.modes.mouseTrackingMode === 'none') return;
    const ms = (a.term as any)._core?.coreMouseService;
    if (!ms) return;
    let button: number, action: number;
    if (wheel) { if (btn > 1) return; button = 4; action = btn === 0 ? 0 : 1; } // 4=wheel, 0=up 1=down
    else if (motion) { button = btn; action = 32; }
    else { button = btn; action = press ? 1 : 0; }
    ms.triggerMouseEvent({ col: x, row, button, action, ctrl: (b & 16) !== 0, alt: (b & 8) !== 0, shift: (b & 4) !== 0 });
  }

  // ── layout ───────────────────────────────────────────────────
  glyph(a: Agent) { return a.status === 'working' ? '◐◓◑◒'[this.spin % 4] : STATUS_STYLE[a.status][0]; }
  marks(a: Agent) {
    const mail = a.inbox.filter((m) => !m.delivered).length;
    const note = this.boardUnread(a);
    return (a.unread ? ' ✓' : '') + (mail ? ` ✉${mail}` : '') + (note ? ` ▤${note}` : '');
  }

  boardUnread(a: Agent) { return this.hub.boardUnread(a.id); }

  boardPanel(W: number, H: number, G: number): { c: Canvas; x: number; y: number } {
    const notes = this.hub.board.slice(-10);
    const w = clamp(W - 4, 20, 110);
    const h = clamp(notes.length + 4, 5, Math.max(5, H - G - 3));
    const x = W - w - 1 >= 0 ? W - w - 1 : 0, y = G + 1;
    const c = new Canvas(w, h);
    const bs = `0;1;${GOLD}`, bg = ';48;5;234';
    c.put(0, 0, '╭' + '─'.repeat(w - 2) + '╮', bs);
    c.put(2, 0, ` Ortak kutu (${this.hub.board.length}) `, bs);
    for (let i = 1; i < h - 1; i++) { c.put(0, i, '│', bs); c.put(1, i, ' '.repeat(w - 2), `0${bg}`); c.put(w - 1, i, '│', bs); }
    const room = h - 4;
    const shown = notes.slice(-room);
    if (!shown.length) c.segs(2, 1, w - 4, [['henüz not yok — coban post all "..."', DIM]], bg, false);
    shown.forEach((m, i) => {
      const t = new Date(m.ts);
      const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      const col = hex(this.hub.agents.get(m.from)?.profile.color);
      c.segs(2, 1 + i, w - 4, [[hhmm + ' ', DIM], [m.from, `1;${col}`], [' ' + flat(m.text), '39']], bg, false);
    });
    c.segs(2, h - 2, w - 4, [['^b m kapat', DIM]], bg, false);
    c.put(0, h - 1, '╰' + '─'.repeat(w - 2) + '╯', bs);
    this.boardBox = { x, y, w, h };
    return { c, x, y };
  }

  workerLines(a: Agent, level: Level): Seg[][] {
    const [, color, label] = STATUS_STYLE[a.status];
    const pc = hex(a.profile.color);
    const id: Seg = [' ' + a.id, (a.id === this.hub.focus ? '1;' : '') + (level === 'mini' ? pc : '39')];
    const head: Seg[] = [[this.glyph(a), color], id, [this.marks(a), MARK]];
    if (level === 'mini') return [head];
    if (level === 'compact') return [[...head, [' ' + a.profile.title, pc]]];
    return [head, [[a.profile.title, pc], [' · ' + label, DIM]]];
  }

  // Width a worker bubble needs, sized for its longest status label so bubbles don't jitter.
  workerWidth(a: Agent, level: Level): number {
    const head = 2 + a.id.length + this.marks(a).length;
    if (level === 'mini') return head;
    if (level === 'compact') return head + 1 + a.profile.title.length;
    return Math.max(head, a.profile.title.length + 3 + Math.max(...Object.values(STATUS_STYLE).map(([, , l]) => l.length)));
  }

  orchLines(a: Agent | undefined, compact: boolean): Seg[][] {
    if (!a) return compact ? [[['+ ', '1;38;5;214'], ['ORKESTRATÖR', `1;${GOLD}`]]] : [[['ORKESTRATÖR', `1;${GOLD}`]], [['+', '1;38;5;214']]];
    const [, color, label] = STATUS_STYLE[a.status];
    const main: Seg[] = [[this.glyph(a), color], [' ' + a.profile.title.replace(' ', ' · '), `1;${hex(a.profile.color)}`], [this.marks(a), MARK]];
    if (compact) return [[['★ ', GOLD], ...main]];
    return [[['ORKESTRATÖR', GOLD]], [...main, [' · ' + label, DIM]]];
  }

  addLines(compact: boolean): Seg[][] {
    return compact ? [[['+ işçi', MARK]]] : [[['+', `1;${MARK}`]], [['işçi', DIM]]];
  }

  plan(W: number, H: number): Plan {
    const hub = this.hub;
    const workers = hub.order.map((id) => hub.agents.get(id)!).filter((a) => a.role !== 'orchestrator');
    const n = workers.length + (hub.order.length ? 1 : 0); // + the "add worker" bubble
    const capG = Math.max(3, Math.min(Math.max(7, Math.round(H * 0.3)), H - 8));
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
      if (want <= fitRows) break;
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
    p.G = Math.min(capG, Math.max(7, used));
    return p;
  }

  graph(W: number, p: Plan): Canvas {
    const hub = this.hub;
    const c = new Canvas(W, p.G + 1);
    this.hits = [];
    const compact = p.bh === 3;
    const cx = Math.floor(W / 2);
    const used = p.bh + p.rows * (p.bh + 1);
    const top = Math.max(0, Math.floor((p.G - used) / 2));
    const num = (id: string) => String(hub.order.indexOf(id) + 1);

    // root: the orchestrator (double-line gold box)
    const orch = hub.agents.get(hub.orchestratorId);
    const ol = this.orchLines(orch, compact);
    const ow = clamp(Math.max(...ol.map(segLen)) + 6, compact ? 18 : 21, W);
    const ox = clamp(cx - Math.floor(ow / 2), 0, W - ow);
    const ofocus = !!orch && orch.id === hub.focus;
    this.box(c, ox, top, ow, p.bh, ol, {
      style: 'double', color: ofocus ? `1;${GOLD}` : GOLD, bg: ofocus ? ';48;5;236' : '',
      label: orch ? num(orch.id) : '', hit: orch ? { kind: 'agent', id: orch.id } : { kind: 'add-orch' },
    });

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
            this.box(c, x, y, p.bw, p.bh, this.workerLines(a, p.level), {
              style: focus ? 'heavy' : 'round', color: (focus ? '1;' : '') + hex(a.profile.color),
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

    // separator / title of the pane below
    const f = hub.agents.get(hub.focus);
    c.put(0, p.G, '─'.repeat(W), '0;38;5;238');
    if (f) {
      const [g, color, label] = STATUS_STYLE[f.status];
      c.put(1, p.G, ' ', '0');
      let x = 2;
      for (const [t, s] of [[g, color], [' ' + f.id, '1'], [' · ', DIM], [f.profile.title, hex(f.profile.color)], [' · ' + label + ' ', DIM]] as Seg[]) {
        c.put(x, p.G, t, `0;${s}`); x += [...t].length;
      }
    } else if (!hub.orchestratorId) {
      c.put(2, p.G, ' ORKESTRATÖR baloncuğundaki + işaretine tıkla (veya Enter) ', `0;${DIM}`);
    }
    return c;
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
    c.put(x, y, k[0] + k[4].repeat(w - 2) + k[1], bs);
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
    c.put(x, y + h - 1, k[2] + k[4].repeat(w - 2) + k[3], bs);
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

  // ── render ───────────────────────────────────────────────────
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.render(); }, 16);
  }

  render() {
    const hub = this.hub;
    const W = out.columns, H = out.rows;
    const p = this.plan(W, H);
    const G = p.G, paneTop = G + 1, P = Math.max(1, H - G - 2);
    this.geo = { G, paneTop, P };
    if (hub.size.cols !== W || hub.size.rows !== P) hub.resizeAll(W, P);

    const graph = this.graph(W, p);
    const focus = hub.agents.get(hub.focus);
    const ov = this.mode === 'pick' ? this.picker(W, H) : undefined;
    if (!ov) this.pickBox = undefined;
    const bp = this.showBoard && !ov ? this.boardPanel(W, H, G) : undefined;
    if (!bp) this.boardBox = undefined;

    const base = (y: number, x0: number, x1: number) =>
      y <= G ? graph.row(y, x0, x1) : this.paneRow(focus, y - paneTop, P, W, x0, x1);
    const lines: string[] = [];
    for (let y = 0; y < H - 1; y++) {
      const o = ov ?? bp;
      if (o && y >= o.y && y < o.y + o.c.h) {
        lines.push(base(y, 0, o.x) + o.c.row(y - o.y) + base(y, o.x + o.c.w, W));
      } else lines.push(base(y, 0, W));
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
      if (focus.cursorVisible && this.mode === 'normal' && !this.prefix && b.cursorY < P) {
        buf += `${ESC}${paneTop + b.cursorY + 1};${b.cursorX + 1}H\x1b[?25h`;
      }
    }
    out.write(buf + '\x1b[?2026l');
  }

  // One pane row, clipped to columns [x0, x1).
  paneRow(a: Agent | undefined, y: number, P: number, W: number, x0: number, x1: number): string {
    const w = x1 - x0;
    if (w <= 0) return '';
    const plain = (s: string, sgr = '0') => `\x1b[${sgr}m${fit(s, W).slice(x0, x1)}\x1b[0m`;
    if (!a) {
      const hint = this.hub.orchestratorId ? '' : 'orkestratör seçmek için yukarıdaki + baloncuğuna tıkla ya da Enter\'a bas';
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

  statusBar(w: number): string {
    const hub = this.hub;
    let left: string;
    if (this.showBoard) hub.markBoardRead('user'); // the open panel counts as read
    const unreadBoard = hub.boardUnread('user');
    if (this.mode === 'pick') left = ' ↑↓ / 1-9 seç · enter onayla · esc iptal ';
    else if (this.selectMode && !this.prefix) left = ' SEÇİM MODU · fareyle seç ve kopyala (⌘C) · çıkmak için ^b s ';
    else if (this.prefix) left = ' ^b → n:yeni  1-9:seç  j/k:gez  o:orkestra  m:ortak kutu  s:seçim/kopyala  u:okunmamış  x:kapat  q:çık  ^b:ctrl-b gönder ';
    else left = ` ^b komut · ${hub.focus || '-'}${unreadBoard ? `  ▤${unreadBoard} ortak kutu (^b m)` : ''} `;
    const bg = this.prefix || this.mode !== 'normal' || this.selectMode ? '\x1b[0;30;48;5;214m' : '\x1b[0;38;5;250;48;5;235m';
    const right = this.notice ? ` ${this.notice} ` : '';
    const room = Math.max(0, w - right.length);
    if (room < 10) return `${bg}${fit(left, w)}\x1b[0m`;
    const l = left.length <= room ? left : fit(left, room);
    const last = hub.log.at(-1);
    const mid = !right && !this.prefix && this.mode === 'normal' && last ? ` ✉ ${last.from}→${last.to}: ${flat(last.text)}` : '';
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
