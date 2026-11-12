import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.ts';

// Persistent session history: one JSON object per line (feed events and messages), newest last.
export type HistoryEntry = { ts: number; kind: 'event' | 'msg'; id: string; text: string; to?: string; detail?: string };

export const historyPath = () => process.env.COBAN_HISTORY || path.join(STATE_DIR, 'history.jsonl');
const MAX_BYTES = 5_000_000; // rotate to history.jsonl.1 beyond this
const MAX_TEXT = 2000;

export function appendHistory(e: HistoryEntry, file = historyPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch {}
    const clip = (s?: string) => (s && s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);
    fs.appendFileSync(file, JSON.stringify({ ...e, text: clip(e.text), detail: clip(e.detail) }) + '\n');
  } catch {} // history must never break the hub
}

export function readHistory(limit = 50, file = historyPath()): HistoryEntry[] {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {} // skip a torn/corrupt line
  }
  return out.slice(-Math.max(1, limit));
}
