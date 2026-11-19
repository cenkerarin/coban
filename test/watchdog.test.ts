// Run: node --disable-warning=ExperimentalWarning test/watchdog.test.ts
// Watchdog: a worker 'working' whose screen stops changing is reported once, and cleared when it moves again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub, progressKey } from '../src/hub.ts';
import type { Config } from '../src/config.ts';

// Spinner / timer / "esc to interrupt" lines are not progress.
assert.equal(progressKey('⏺ Bash(npm test)\n✻ Working… (12s · ↓ 300 tokens · esc to interrupt)'), progressKey('⏺ Bash(npm test)\n✶ Working… (13m 4s · ↓ 1.2k tokens · esc to interrupt)'));
assert.notEqual(progressKey('⏺ Bash(npm test)'), progressKey('⏺ Bash(npm test)\n  ⎿ 12 passed'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-wd-'));
const flag = path.join(tmp, 'step');
const script = path.join(tmp, 'busy.sh');
// Spins forever (output keeps flowing, so it stays 'working'); prints a real line only when `flag` appears.
fs.writeFileSync(script, `echo basladi\ni=0\nwhile :; do i=$((i+1)); if [ -f '${flag}' ]; then rm -f '${flag}'; printf '\\r\\033[Kadim %s\\n' $i; fi; printf '\\r\\033[K* Working (%ss) esc to interrupt' $i; sleep 0.2; done\n`);

const cfg: Config = {
  orchestrator: 'o',
  stuckMinutes: 0.025, // 1.5 s
  profiles: [
    { id: 'o', title: 'orch', cmd: `sh -c 'sleep 60'`, promptArg: '' },
    { id: 'b', title: 'Busy', cmd: `/bin/sh ${script}`, promptArg: '' },
  ],
};
const hub = new Hub(cfg);
hub.notifier = () => {};
const stuck: any[] = [], unstuck: any[] = [];
hub.on('stuck', (s) => stuck.push(s));
hub.on('unstuck', (s) => unstuck.push(s));
const until = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reports = () => hub.log.filter((m) => m.from === 'coban' && m.to === 'orkestra' && /ekranı değişmiyor/.test(m.text));
const row = () => hub.list().find((a) => a.id === 'w') as any;

try {
  hub.spawn({ profile: 'o', role: 'orchestrator' });
  hub.spawn({ profile: 'b', role: 'worker', name: 'w', task: 'T', cwd: tmp });
  await until(() => hub.get('w').status === 'working');
  assert.equal(row().stuckMin, undefined, 'not stuck right away');

  // Unchanged screen → reported once (message to the orchestrator, 'stuck' event, marked in the agents list).
  await until(() => stuck.length === 1);
  assert.equal(stuck[0].id, 'w');
  assert.equal(reports().length, 1);
  assert.ok(!reports()[0].text.includes('Working'), 'no screen text in the report');
  assert.ok(row().stuckMin >= 1, 'agents row carries stuckMin');
  await sleep(2000);
  assert.equal(stuck.length, 1, 'reported only once while still stuck');
  assert.equal(reports().length, 1);

  // Progress (a real new line) clears it.
  fs.writeFileSync(flag, '');
  await until(() => unstuck.length === 1);
  assert.equal(row().stuckMin, undefined, 'cleared after progress');
  assert.equal(hub.stuckFor('w'), 0);

  // Stuck again afterwards → a fresh report.
  await until(() => stuck.length === 2);
  assert.equal(reports().length, 2);

  // Killing a stuck worker forgets it.
  hub.kill('w');
  hub.watchdog();
  assert.equal(hub.stuckFor('w'), 0);
} finally {
  for (const id of [...hub.order]) try { hub.kill(id); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
