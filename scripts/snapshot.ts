// Renders docs/screenshot.svg: coban with scripted demo agents (scripts/demo-agent.mjs), captured mid-animation.
// Run: npm run snapshot
import fs from 'node:fs';
import path from 'node:path';
import { startCoban, sleep, until, ROOT } from '../test/helpers.ts';

const COLS = 200, ROWS = 48;
const demo = (id: string, title: string, color: string) =>
  ({ id, title, color, cmd: `${process.execPath} ${path.join(ROOT, 'scripts', 'demo-agent.mjs')}`, promptArg: '{prompt}' });

const c = await startCoban(COLS, ROWS, [demo('h1', 'Claude H1', '#F6D5C8'), demo('h2', 'Claude H2', '#FFD9A0'), demo('h3', 'Claude H3', '#C8E6C9')]);
try {
  c.write('\r'); await sleep(300); c.write('1');
  await until(async () => (await c.cli('', 'agents')).includes('★'));
  await c.cli('orkestra', 'spawn', 'h2', 'HEDEF: POST /login endpointi', '--name', 'api');
  await c.cli('orkestra', 'spawn', 'h3', 'HEDEF: giriş formu ve token saklama', '--name', 'istemci');
  await c.cli('orkestra', 'spawn', 'h1', 'HEDEF: login uçtan uca testleri ASK', '--name', 'test');
  await sleep(1500);
  await c.cli('api', 'post', 'all', 'POST /login artık {token, user} döndürüyor; hata 401 + {error}');
  await sleep(900);
  await c.cli('istemci', 'post', 'api', "token'ı localStorage'a yazıyorum — refresh endpoint'i var mı?");
  await sleep(900);
  await c.cli('api', 'post', 'istemci', 'evet: POST /refresh, gövde {token}');
  await sleep(900);
  await c.cli('api', 'post', 'orkestra', 'api bitti: POST /login + /refresh, testler yeşil');
  await sleep(2600);
  await c.cli('istemci', 'post', 'all', 'Login formu hazır; /refresh 401 dönerse oturumu kapatıyor');
  await sleep(230); // packets in flight
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  const out = path.join(ROOT, 'docs', 'screenshot.svg');
  fs.writeFileSync(out, toSvg(c.term));
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
} finally {
  await c.stop();
}

// ── xterm buffer → SVG ───────────────────────────────────────
function toSvg(term: any): string {
  const CW = 8.4, LH = 18, PAD = 14, FG = '#d4d4d4', BG = '#1e1e1e';
  const pal = palette();
  const color = (mode: 'fg' | 'bg', cell: any): string | null => {
    const rgb = mode === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
    const idx = mode === 'fg' ? cell.isFgPalette() : cell.isBgPalette();
    const v = mode === 'fg' ? cell.getFgColor() : cell.getBgColor();
    if (rgb) return '#' + v.toString(16).padStart(6, '0');
    if (idx) return pal[v];
    return null;
  };
  // spaces become NBSP: some SVG renderers collapse whitespace even with xml:space="preserve"
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '\u00a0');
  const b = term.buffer.active, cell = b.getNullCell();
  const rects: string[] = [], texts: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = b.getLine(b.viewportY + y);
    if (!line) continue;
    type Run = { x: number; n: number; text: string; fg: string; bg: string | null; bold: boolean; dim: boolean; italic: boolean };
    let run: Run | null = null;
    const flush = () => {
      if (!run) return;
      const px = PAD + run.x * CW, py = PAD + y * LH;
      if (run.bg) rects.push(`<rect x="${px.toFixed(1)}" y="${py}" width="${(run.n * CW).toFixed(1)}" height="${LH}" fill="${run.bg}"/>`);
      if (run.text.trim()) {
        const attrs = [`x="${px.toFixed(1)}"`, `y="${py + 13}"`, `fill="${run.fg}"`, `textLength="${(run.n * CW).toFixed(1)}"`, 'lengthAdjust="spacing"'];
        if (run.bold) attrs.push('font-weight="700"');
        if (run.dim) attrs.push('opacity="0.6"');
        if (run.italic) attrs.push('font-style="italic"');
        texts.push(`<text ${attrs.join(' ')}>${esc(run.text)}</text>`);
      }
      run = null;
    };
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;
      let fg = color('fg', cell) ?? FG, bg = color('bg', cell);
      if (cell.isInverse()) { const t = fg; fg = bg ?? BG; bg = t; }
      const bold = !!cell.isBold(), dim = !!cell.isDim(), italic = !!cell.isItalic();
      const ch = cell.getChars() || ' ';
      const same = run && run.fg === fg && run.bg === bg && run.bold === bold && run.dim === dim && run.italic === italic && w === 1;
      if (!same) { flush(); run = { x, n: 0, text: '', fg, bg, bold, dim, italic }; }
      run!.text += ch; run!.n += w;
      if (w > 1) flush();
    }
    flush();
  }
  const W = Math.ceil(PAD * 2 + term.cols * CW), H = PAD * 2 + term.rows * LH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="100%" height="100%" rx="10" fill="${BG}"/>
<g font-family="'SF Mono', Menlo, 'DejaVu Sans Mono', Consolas, monospace" font-size="14" xml:space="preserve" style="white-space:pre">
${rects.join('\n')}
${texts.join('\n')}
</g>
</svg>
`;
}

function palette(): string[] {
  const base = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
    '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const steps = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) base.push(`#${hex(steps[r])}${hex(steps[g])}${hex(steps[b])}`);
  for (let i = 0; i < 24; i++) { const v = 8 + i * 10; base.push(`#${hex(v)}${hex(v)}${hex(v)}`); }
  return base;
}
