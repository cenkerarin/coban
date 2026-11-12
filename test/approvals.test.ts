// Approval inbox and coban's own input line, end to end against the fake agent's Claude-style menu.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCoban, until, sleep, type Coban } from './helpers.ts';

let c: Coban;
after(async () => { await c?.stop(); });

const blocked = (id: string) => async () => new RegExp(`^${id} .*blocked`, 'm').test(await c.cli('', 'agents'));

test('approvals: list, answer from the CLI and from the panel', async () => {
  c = await startCoban();
  c.write('\r'); await sleep(300); c.write('1');
  await until(async () => (await c.cli('', 'agents')).includes('★'));
  await c.cli('orkestra', 'spawn', 'fake', 'temizle MENU', '--name', 'm1');
  await c.cli('orkestra', 'spawn', 'fake', 'yine MENU', '--name', 'm2');
  await c.cli('orkestra', 'spawn', 'fake', 'onay ASK', '--name', 'q1');
  await until(blocked('m1')); await until(blocked('m2')); await until(blocked('q1'));

  const list = await c.cli('orkestra', 'approvals');
  assert.match(list, /^m1 {2}fake {2}Bash command · Remove the build folder · rm -rf build$/m);
  assert.match(list, /\? Do you want to proceed\? {2}1\) Yes {2}2\) Yes, and don't ask again for rm commands {2}3\) No/);
  assert.match(list, /^q1 .*\n {2}\? Do you want to proceed\? \(y\/n\)$/m);

  // CLI: "no" walks the menu down to the last option
  assert.equal(await c.cli('orkestra', 'approve', 'm1', 'no'), 'm1: "No" seçildi');
  await until(async () => (await c.cli('', 'read', 'm1')).includes('chose: No'));
  assert.equal(await c.cli('orkestra', 'approve', 'q1'), 'q1: "y" seçildi');
  await until(async () => (await c.cli('', 'read', 'q1')).includes('approved'));
  assert.match(await c.cli('', 'approve', 'q1'), /ERR .*soru beklemiyor/);

  // panel: it is on screen, and ^b a picks the "Yes, and …" option of the selected (only) item
  await until(() => /İZİN BEKLEYENLER \(1\)/.test(c.screen()));
  assert.match(c.screen(), /\[a\] Yes, and don't ask again/);
  c.write('\x02a');
  await until(async () => (await c.cli('', 'read', 'm2')).includes("chose: Yes, and don't ask again for rm commands"));
  await until(() => !/İZİN BEKLEYENLER/.test(c.screen()));
  // hub.answer() resolves a moment after the agent reacts (the panel is already gone by then), so wait for the feed line
  await until(() => /izin: Yes, and don't ask again/.test(c.screen()));   // the feed records the decision
});

test('input line: @id goes to that agent, @all to the board', async () => {
  await c.cli('m2', 'agents');   // m2's token needs a confirmation box: do it before the timed wait below, and before the input line opens
  c.write('\x02c'); await sleep(150);
  c.write('@m1 selam'); await sleep(150);
  assert.match(c.screen(), /sen → m1/);
  c.write('\r');
  await until(async () => /user→m1: selam/.test(await c.cli('', 'log')));
  c.write('@all karar: v2'); c.write('\r');
  await until(async () => /\[ortak\] user: karar: v2/.test(await c.cli('m2', 'inbox')));
  c.write('@yok x'); c.write('\r');
  await until(() => /agent yok: @yok/.test(c.screen()), 3000, 20);   // a flash: poll tightly, a fixed sleep can miss the frame
  c.write('\x15\x1b'); // clear, leave the input line
});
