// Column widths, and the ^b < / ^b > keys that change them.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startCoban, until, sleep, fakeProfile, type Coban } from './helpers.ts';
import { columnWidths } from '../src/tui.ts';

let c: Coban | undefined;
afterEach(async () => { await c?.stop(); c = undefined; });

const chatColumn = (s: string) => s.split('\n').find((l) => l.includes('SOHBET'))?.indexOf('SOHBET') ?? -1;

async function withAgent(cols: number, extra = {}) {
  c = await startCoban(cols, 46, [fakeProfile()], extra);
  c.write('\r'); await sleep(300); c.write('1');
  await until(() => chatColumn(c!.screen()) >= 0);
  return c;
}

test('the default share keeps the original column widths', () => {
  assert.deepEqual(columnWidths(179, 0.42, false), { fw: 43, gw: 59, pw: 75 });
});

test('a bigger chat share takes room from both other columns', () => {
  const a = columnWidths(179, 0.42, false), b = columnWidths(179, 0.5, false);
  assert.ok(b.pw > a.pw, `chat ${a.pw} -> ${b.pw}`);
  assert.ok(b.fw < a.fw, `feed ${a.fw} -> ${b.fw}`);
  assert.ok(b.gw < a.gw, `graph ${a.gw} -> ${b.gw}`);
  assert.equal(b.fw + b.gw + b.pw + 2, 179);
});

test('the graph keeps its minimum width at the largest share', () => {
  assert.ok(columnWidths(179, 0.6, false).gw >= 40);
  assert.ok(columnWidths(140, 0.6, false).gw >= 40);
});

test('^b < widens the chat pane, ^b > narrows it, and the choice is saved', async () => {
  const s = await withAgent(180);
  const saved = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8')).chatWidth;
  const start = chatColumn(s.screen());
  s.write('\x02<');
  await until(() => chatColumn(s.screen()) < start);
  assert.equal(saved(), 0.46);
  s.write('\x02>');
  await until(() => chatColumn(s.screen()) === start);
  assert.equal(saved(), 0.42);
});

test('the share stops at its limits', async () => {
  const s = await withAgent(180, { chatWidth: 0.58 });
  s.write('\x02<'); await sleep(200); s.write('\x02<'); await sleep(200);
  const saved = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8')).chatWidth;
  await until(() => saved() === 0.6);
});

test('chatWidth from the config applies at start', async () => {
  const wide = await withAgent(180, { chatWidth: 0.58 });
  const col = chatColumn(wide.screen());
  await wide.stop(); c = undefined;
  const plain = await withAgent(180);
  assert.ok(col < chatColumn(plain.screen()), `${col} vs ${chatColumn(plain.screen())}`);
});

const savedShare = (s: Coban) => JSON.parse(fs.readFileSync(path.join(s.dir, 'config.json'), 'utf8')).chatWidth;
const prefixThen = async (s: Coban, key: string) => { s.write('\x02'); await sleep(60); s.write(key); };

test('after ^b, left arrow widens the chat and right arrow narrows it', async () => {
  const s = await withAgent(180);
  await prefixThen(s, '\x1b[D');
  await until(() => savedShare(s) === 0.46);
  await prefixThen(s, '\x1b[C');
  await until(() => savedShare(s) === 0.42);
  await prefixThen(s, '\x1bOD');   // application cursor mode
  await until(() => savedShare(s) === 0.46);
});

test('arrows keep resizing right after a resize, then go back to the agent', async () => {
  const s = await withAgent(180);
  await prefixThen(s, '\x1b[D');
  await until(() => savedShare(s) === 0.46);
  s.write('\x1b[D');
  await until(() => savedShare(s) === 0.5);
  await sleep(1300);
  s.write('\x1b[D');
  await sleep(300);
  assert.equal(savedShare(s), 0.5);
});
