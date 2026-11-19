import { readHistory, type HistoryEntry } from './history.ts';

// Turns the persisted history into a readable Markdown report. Pure: only reads the history file.
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ts: number) => { const d = new Date(ts); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`; };
const hms = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}sa ${Math.floor((s % 3600) / 60)}dk` : s >= 60 ? `${Math.floor(s / 60)}dk ${s % 60}sn` : `${s}sn`; };
const one = (s = '') => s.replace(/\s+/g, ' ').trim();
const cell = (s: string) => one(s).replace(/\|/g, '\\|');

export function renderReport(entries: HistoryEntry[]): string {
  if (!entries.length) return '# coban raporu\n\nGeçmiş boş: dışa aktarılacak kayıt yok.\n';
  const es = [...entries].sort((a, b) => a.ts - b.ts);
  const events = es.filter((e) => e.kind === 'event');
  const notes = es.filter((e) => e.kind === 'msg' && e.to === 'all');

  const out: string[] = ['# coban raporu', '', `- Aralık: ${stamp(es[0].ts)} → ${stamp(es[es.length - 1].ts)} (${hms(es[es.length - 1].ts - es[0].ts)})`,
    `- Kayıt: ${events.length} olay, ${es.length - events.length} mesaj`, '', '## Zaman çizelgesi', ''];
  for (const e of es) {
    out.push(e.kind === 'msg'
      ? `- ${stamp(e.ts)} **${e.id}** → ${e.to}: ${one(e.text)}`
      : `- ${stamp(e.ts)} **${e.id}**: ${one(e.text)}${e.detail ? ` — ${one(e.detail)}` : ''}`);
  }

  // Worker table: spawn event is "<role> açıldı · <profile title>"; the end is the last close event.
  type W = { id: string; profile: string; start: number; end?: number; last: string };
  const workers = new Map<string, W>();
  for (const e of events) {
    const m = /açıldı · (.+)$/.exec(e.text);
    if (m) { workers.set(e.id, { id: e.id, profile: m[1], start: e.ts, last: 'çalışıyor' }); continue; }
    const w = workers.get(e.id);
    if (!w) continue;
    w.last = one(e.text);
    if (/süreç kapandı|kapatıldı|kapandı/.test(e.text)) w.end = e.ts;
  }
  out.push('', '## İşçiler', '');
  if (!workers.size) out.push('(işçi kaydı yok)');
  else {
    const last = es[es.length - 1].ts;
    out.push('| id | profil | süre | son durum |', '|---|---|---|---|');
    for (const w of workers.values()) out.push(`| ${cell(w.id)} | ${cell(w.profile)} | ${hms((w.end ?? last) - w.start)}${w.end ? '' : '+'} | ${cell(w.last)} |`);
  }

  out.push('', '## Kararlar (pano notları)', '');
  if (!notes.length) out.push('(pano notu yok)');
  for (const n of notes) out.push(`- ${stamp(n.ts)} **${n.id}**: ${one(n.text)}`);
  return out.join('\n') + '\n';
}

export const exportReport = (file?: string) => renderReport(readHistory(Number.MAX_SAFE_INTEGER, file));
