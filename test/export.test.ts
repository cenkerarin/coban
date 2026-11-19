import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportReport, renderReport } from '../src/export.ts';
import type { HistoryEntry } from '../src/history.ts';

const T = Date.UTC(2026, 0, 2, 10, 0, 0);
const fixture: HistoryEntry[] = [
  { ts: T, kind: 'event', id: 'a1', text: 'işçi açıldı · Hesap A', detail: 'görev 1' },
  { ts: T + 5000, kind: 'msg', id: 'a1', to: 'all', text: 'karar: X | Y kullan' },
  { ts: T + 90000, kind: 'event', id: 'a1', text: 'durdu · 90 sn çalıştı' },
  { ts: T + 100000, kind: 'event', id: 'a1', text: 'süreç kapandı' },
  { ts: T + 20000, kind: 'msg', id: 'user', to: 'a1', text: 'selam' },
];

test('renderReport: deterministic markdown from fixture', () => {
  const md = renderReport(fixture);
  assert.equal(md, renderReport([...fixture].reverse()));
  assert.match(md, /^# coban raporu/);
  assert.match(md, /\| a1 \| Hesap A \| 1dk 40sn \| süreç kapandı \|/);
  assert.match(md, /- 2026-01-02 10:00:05Z \*\*a1\*\*: karar: X \| Y kullan/);
  assert.ok(md.indexOf('## Zaman çizelgesi') < md.indexOf('## İşçiler') && md.indexOf('## İşçiler') < md.indexOf('## Kararlar'));
  assert.equal(md.split('## Kararlar')[1].includes('selam'), false); // direct messages are not decisions
});

test('exportReport: empty or missing history gives a clear message', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coban-exp-')), 'h.jsonl');
  assert.match(exportReport(f), /Geçmiş boş/);
  fs.writeFileSync(f, JSON.stringify(fixture[0]) + '\n');
  assert.match(exportReport(f), /\| a1 \| Hesap A \|/);
});
