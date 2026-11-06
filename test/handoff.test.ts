// Run: node --disable-warning=ExperimentalWarning test/handoff.test.ts
// A worker whose screen shows a usage-limit message must be handed to the least-spent account of the same kind.
import assert from 'node:assert/strict';
import os from 'node:os';
import { Hub } from '../src/hub.ts';
import type { Config } from '../src/config.ts';

const sh = (script: string) => `sh -c '${script}'`;
const cfg: Config = {
  orchestrator: 'o',
  profiles: [
    { id: 'o', title: 'orch', cmd: sh('sleep 30'), promptArg: '' },
    { id: 'a1', title: 'A1', cmd: sh('echo working on step 1; echo edited src/x.ts; echo You have hit your usage limit; sleep 30'), promptArg: '' },
    { id: 'a2', title: 'A2', cmd: sh('sleep 30'), promptArg: '' },
    { id: 'x', title: 'other kind', cmd: 'sleep 30', promptArg: '' },
  ],
};
const hub = new Hub(cfg);
const events: any[] = [];
hub.on('handoff', (h) => events.push(h));
const cwd = os.tmpdir();
hub.spawn({ profile: 'o', role: 'orchestrator' });
hub.spawn({ profile: 'a1', role: 'worker', name: 'w', task: 'HEDEF: test görevi', cwd });
hub.spawn({ profile: 'a1', role: 'manual', name: 'm' }); // manual agents are never handed off

const until = async (f: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};
await until(() => events.length > 0);
await new Promise((r) => setTimeout(r, 1500)); // a second trigger would land here

assert.equal(events.length, 1, 'handoff fires once');
assert.deepEqual(events[0], { from: 'w', to: 'w-devir', fromProfile: 'a1', toProfile: 'a2' });
assert.ok(!hub.agents.has('w'), 'old worker killed');
const b = hub.get('w-devir');
assert.equal(b.profile.id, 'a2');
assert.equal(b.cwd, cwd);
assert.match(b.task, /You have hit your usage limit/);
assert.match(b.task, /edited src\/x\.ts/);
assert.match(b.task, /ORİJİNAL GÖREV:\nHEDEF: test görevi$/);
assert.ok(hub.agents.has('m'), 'manual agent kept');
assert.ok(hub.board.some((m) => m.text.includes('w limitten a2 hesabına devredildi')), 'board note');
assert.ok(hub.log.some((m) => m.to === 'orkestra' && m.text.includes('devredildi')), 'orchestrator told');

// No eligible account (a2 and a1 now limited) → only the orchestrator is told.
hub.limitedAt.set('a2', Date.now()); hub.limitedAt.set('o', Date.now()); // orchestrator's account is the last-resort target
hub.spawn({ profile: 'a1', role: 'worker', name: 'w2', task: 'T2', cwd });
await until(() => events.length > 1);
assert.deepEqual(events[1], { from: 'w2', to: null, fromProfile: 'a1', toProfile: null });
assert.ok(hub.agents.has('w2'), 'no target → worker left in place');
assert.ok(hub.log.some((m) => m.to === 'orkestra' && m.text.includes('uygun hesap yok')));
assert.equal(hub.handoff('w2'), null, 'debounced');

console.log('handoff test OK');
for (const id of [...hub.order]) hub.kill(id);
process.exit(0);
