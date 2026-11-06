import type { Agent, Msg, Status } from './agent.ts';
import type { Hub } from './hub.ts';

const SIDEBAR = 31;
const PREFIX = '\x02'; // ctrl+b
const out = process.stdout;
const ESC = '\x1b[';

const STATUS_STYLE: Record<Status, [string, string, string]> = {
  //          glyph, color,        label
  starting: ['◌', '38;5;244', 'açılıyor'],
  working:  ['●', '38;5;214', 'çalışıyor'],
  blocked:  ['!', '1;38;5;203', 'izin bekliyor'],
  limited:  ['⧗', '1;38;5;199', 'limit doldu'],
  idle:     ['○', '38;5;248', 'boşta'],
  exited:   ['×', '38;5;240', 'kapandı'],
};

const hex = (h?: string) => {
  const m = h?.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? `38;2;${parseInt(m[1], 16)};${parseInt(m[2], 16)};${parseInt(m[3], 16)}` : '39';
};
const fit = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s + ' '.repeat(w - s.length));
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

export class Tui {
  hub: Hub;
  prev: string[] = [];
  scheduled = false;
  prefix = false;
  mode: 'normal' | 'pick-profile' = 'normal';
  notice = '';
  noticeTimer?: NodeJS.Timeout;
  outerAppCursor = false;
  spin = 0;

  constructor(hub: Hub) {
    this.hub = hub;
    hub.on('render', (a: Agent) => { if (a.id === hub.focus) this.schedule(); });
    hub.on('change', () => this.schedule());
    hub.on('notify', (m: Msg) => this.flash(`✉ ${m.from}: ${flat(m.text)}`, 15000));
    setInterval(() => { this.spin++; if ([...hub.agents.values()].some((a) => a.status === 'working')) this.schedule(); }, 500).unref();
  }

  get paneSize() {
    return { cols: Math.max(20, out.columns - SIDEBAR - 1), rows: Math.max(5, out.rows - 1) };
  }

  start() {
    out.write('\x1b[?1049h\x1b[?2004h\x1b[2J');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d: Buffer) => this.input(d.toString('utf8')));
    out.on('resize', () => {
      const { cols, rows } = this.paneSize;
      this.hub.resizeAll(cols, rows);
      this.prev = [];
      out.write('\x1b[2J');
      this.schedule();
    });
    this.schedule();
  }

  stop() {
    out.write('\x1b[0m\x1b[?25h\x1b[?1l\x1b[?2004l\x1b[?1049l');
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
  input(d: string) {
    const hub = this.hub;
    if (this.mode === 'pick-profile') {
      this.mode = 'normal';
      const p = hub.cfg.profiles[Number(d) - 1];
      if (p) {
        try { hub.setFocus(hub.spawn({ profile: p.id, role: 'manual' }).id); }
        catch (e: any) { this.flash(e.message); }
      }
      return this.schedule();
    }
    if (this.prefix) {
      this.prefix = false;
      return this.command(d);
    }
    if (d === PREFIX) { this.prefix = true; return this.schedule(); }

    const a = hub.agents.get(hub.focus);
    if (!a || a.exitCode !== null) return;
    if (!a.term.modes.bracketedPasteMode) d = d.replace(/\x1b\[20[01]~/g, '');
    a.proc.write(d);
  }

  command(c: string) {
    const hub = this.hub;
    const idx = hub.order.indexOf(hub.focus);
    const move = (n: number) => hub.order.length && hub.setFocus(hub.order[(idx + n + hub.order.length) % hub.order.length]);
    switch (c) {
      case 'n': this.mode = 'pick-profile'; break;
      case 'j': case '\x1b[B': move(1); break;
      case 'k': case '\x1b[A': move(-1); break;
      case 'o': if (hub.orchestratorId) hub.setFocus(hub.orchestratorId); break;
      case 'u': { const u = hub.order.find((id) => hub.agents.get(id)!.unread); if (u) hub.setFocus(u); break; }
      case 'x': if (hub.focus && hub.agents.get(hub.focus)?.role !== 'orchestrator') hub.kill(hub.focus); else this.flash('orkestratör kapatılamaz (çıkış: ^b q)'); break;
      case 'q': process.emit('SIGTERM'); return;
      case PREFIX: hub.agents.get(hub.focus)?.proc.write(PREFIX); break;
      default:
        if (/^[1-9]$/.test(c) && hub.order[Number(c) - 1]) hub.setFocus(hub.order[Number(c) - 1]);
    }
    this.schedule();
  }

  // ── render ───────────────────────────────────────────────────
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => { this.scheduled = false; this.render(); }, 16);
  }

  render() {
    const W = out.columns, H = out.rows;
    const focus = this.hub.agents.get(this.hub.focus);
    const side = this.sidebar(H - 1);
    const pane = focus ? this.pane(focus, W - SIDEBAR - 1, H - 1) : [];
    const lines: string[] = [];
    for (let y = 0; y < H - 1; y++) {
      lines.push(side[y] + `\x1b[0;38;5;238m│\x1b[0m` + (pane[y] ?? ' '.repeat(W - SIDEBAR - 1)));
    }
    lines.push(this.statusBar(W));

    let buf = '\x1b[?2026h\x1b[?25l'; // synchronized update
    for (let y = 0; y < lines.length; y++) {
      if (this.prev[y] !== lines[y]) buf += `${ESC}${y + 1};1H${lines[y]}\x1b[0m`;
    }
    this.prev = lines;

    if (focus) {
      const appCursor = focus.term.modes.applicationCursorKeysMode;
      if (appCursor !== this.outerAppCursor) { buf += appCursor ? '\x1b[?1h' : '\x1b[?1l'; this.outerAppCursor = appCursor; }
      const b = focus.term.buffer.active;
      if (focus.cursorVisible && this.mode === 'normal' && !this.prefix && b.cursorY < H - 1) {
        buf += `${ESC}${b.cursorY + 1};${SIDEBAR + 2 + b.cursorX}H\x1b[?25h`;
      }
    }
    out.write(buf + '\x1b[?2026l');
  }

  sidebar(h: number): string[] {
    const hub = this.hub;
    const rows: string[] = [];
    const push = (s: string, style = '') => rows.push(`\x1b[0m${style}${fit(s, SIDEBAR)}\x1b[0m`);
    push(' coban', '\x1b[1;38;5;223m');
    push('');
    hub.order.forEach((id, i) => {
      const a = hub.agents.get(id)!;
      const [glyph, color, label] = STATUS_STYLE[a.status];
      const sel = id === hub.focus;
      const bg = sel ? '\x1b[48;5;236m' : '';
      const g = a.status === 'working' ? '◐◓◑◒'[this.spin % 4] : glyph;
      const name = `${i + 1} ${a.role === 'orchestrator' ? '★ ' : ''}${id}`;
      const mail = a.inbox.filter((m) => !m.delivered).length;
      const right = (a.unread ? ' ✓' : '') + (mail ? ` ✉${mail}` : '');
      rows.push(`\x1b[0m${bg}${sel ? '\x1b[1m▌' : ' '}\x1b[0m${bg}\x1b[${color}m${g}\x1b[0m${bg}${sel ? '\x1b[1m' : ''} ${fit(name, SIDEBAR - 3 - right.length)}\x1b[0m${bg}\x1b[38;5;114m${right}\x1b[0m`);
      rows.push(`\x1b[0m${bg}     \x1b[${hex(a.profile.color)}m${fit(a.profile.title, 10)}\x1b[0m${bg}\x1b[38;5;244m${fit(' ' + label, SIDEBAR - 15)}\x1b[0m`);
    });

    // recent bus messages fill the bottom of the sidebar
    const room = h - rows.length - 2;
    if (room > 2 && hub.log.length) {
      const msgs: string[] = [];
      for (const m of hub.log.slice().reverse()) {
        const head = `${m.from}→${m.to}`;
        const text = flat(m.text);
        msgs.unshift(`\x1b[0m\x1b[38;5;180m${fit(head, SIDEBAR)}\x1b[0m`, `\x1b[0m\x1b[38;5;246m${fit(' ' + text, SIDEBAR)}\x1b[0m`);
        if (msgs.length >= room - 1) break;
      }
      while (rows.length < h - msgs.length - 1) push('');
      push('─ mesajlar ' + '─'.repeat(SIDEBAR - 11), '\x1b[38;5;238m');
      rows.push(...msgs.slice(-(h - rows.length)));
    }
    while (rows.length < h) push('');
    return rows.slice(0, h);
  }

  pane(a: Agent, w: number, h: number): string[] {
    const b = a.term.buffer.active;
    const res: string[] = [];
    const cell = b.getNullCell();
    for (let y = 0; y < h; y++) {
      const line = b.getLine(b.viewportY + y);
      if (!line) { res.push(' '.repeat(w)); continue; }
      let s = '', last = '', col = 0;
      for (let x = 0; x < Math.min(w, a.term.cols); x++) {
        line.getCell(x, cell);
        const cw = cell.getWidth();
        if (cw === 0) continue;
        if (col + cw > w) break;
        const sgr = sgrOf(cell);
        if (sgr !== last) { s += `\x1b[${sgr}m`; last = sgr; }
        s += cell.getChars() || ' ';
        col += cw;
      }
      res.push(s + '\x1b[0m' + ' '.repeat(Math.max(0, w - col)));
    }
    if (a.status === 'exited') res[h - 1] = `\x1b[0;7m${fit(` süreç kapandı (kod ${a.exitCode}) — ^b x ile listeden kaldır`, w)}\x1b[0m`;
    return res;
  }

  statusBar(w: number): string {
    const hub = this.hub;
    let left: string;
    if (this.mode === 'pick-profile') left = ' yeni agent: ' + hub.cfg.profiles.map((p, i) => `${i + 1}:${p.id}`).join('  ') + '   (başka tuş: iptal)';
    else if (this.prefix) left = ' ^b → n:yeni  1-9:seç  j/k:gez  o:orkestra  u:okunmamış  x:kapat  q:çık  ^b:ctrl-b gönder';
    else left = ` ^b komut · ${hub.focus || '-'}`;
    const bg = this.prefix || this.mode !== 'normal' ? '\x1b[0;30;48;5;214m' : '\x1b[0;38;5;250;48;5;235m';
    const right = this.notice ? ` ${this.notice} ` : '';
    const room = w - right.length;
    if (room < 10) return `${bg}${fit(left, w)}\x1b[0m`;
    return `${bg}${fit(left, room)}\x1b[0;30;48;5;223m${right}\x1b[0m`;
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
