// Run: node --disable-warning=ExperimentalWarning test/notify.test.ts
// macOS notification (config-gated, argv-safe) and one-shot takeover of a crashed worker.
import assert from 'node:assert/strict';
import os from 'node:os';
import { Hub } from '../src/hub.ts';
import { notify } from '../src/notify.ts';
import type { Config } from '../src/config.ts';

delete process.env.COBAN_NO_NOTIFY;
const calls: any[][] = [];
const fake: any = (...a: any[]) => { calls.push(a); return { unref() {} }; };
if (process.platform === 'darwin') {
  assert.equal(notify({}, 't', 'x"; do shell script "rm"', fake), true);
  assert.deepEqual(calls[0][1].slice(-2), ['x"; do shell script "rm"', 't'], 'text passed as argv');
}
assert.equal(notify({ notify: false }, 't', 'x', fake), false, 'disabled by config');
process.env.COBAN_NO_NOTIFY = '1';
assert.equal(notify({}, 't', 'x', fake), false, 'disabled by env');

const sh = (s: string) => `sh -c '${s}'`;
const cfg: Config = {
  orchestrator: 'o',
  profiles: [
    { id: 'o', title: 'orch', cmd: sh('sleep 30'), promptArg: '' },
    { id: 'c1', title: 'C1', cmd: sh('echo boom; exit 3'), promptArg: '' },
    { id: 'c2', title: 'C2', cmd: sh('sleep 30'), promptArg: '' },
    { id: 'o2', title: 'orch2', cmd: `/bin/sh -c 'echo "Do you want to proceed?"; echo "❯ 1. Yes"; echo "  2. No"; sleep 30'`, promptArg: '' },
    { id: 'ok', title: 'OK', cmd: '/bin/sh -c "exit 0"', promptArg: '' },
    { id: 'pm', title: 'PM', cmd: `/bin/sh -c 'echo "Do you want to proceed?"; echo "❯ 1. Yes"; echo "  2. No"; sleep 30'`, promptArg: '' },
  ],
};
const hub = new Hub(cfg);
hub.handoffVerifyMs = 300;
const notes: string[] = [];
hub.notifier = (_t, x) => { notes.push(x); };
const events: any[] = [];
hub.on('handoff', (h) => events.push(h));
const cwd = os.tmpdir();
const until = async (f: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};

hub.spawn({ profile: 'o', role: 'orchestrator' });
// Crash (exit 3) → one takeover; the replacement (also exits 3) is not taken over again.
hub.spawn({ profile: 'c1', role: 'worker', name: 'w', task: 'HEDEF: x', cwd });
await until(() => events.length > 0);
assert.equal(events[0].from, 'w');
await new Promise((r) => setTimeout(r, 1500));
assert.equal(events.length, 1, 'at most one takeover per chain');
assert.ok(!hub.agents.has('w-devir-devir'));
assert.ok(hub.log.some((m) => m.to === 'orkestra' && /çık|çök/.test(m.text)));

// Clean exit (code 0) and hub.kill are not crashes.
const before = events.length;
hub.spawn({ profile: 'ok', role: 'worker', name: 'fin', task: 'T', cwd });
hub.spawn({ profile: 'c2', role: 'worker', name: 'k', task: 'T', cwd });
await new Promise((r) => setTimeout(r, 800));
hub.kill('k');
await new Promise((r) => setTimeout(r, 800));
assert.equal(events.length, before, 'no takeover for clean exit or kill');

// Blocked worker → notification only after notifyDelay of continuous blocked state.
cfg.notifyDelay = 0.8;
hub.spawn({ profile: 'o2', role: 'orchestrator', name: 'orch2' });
await new Promise((r) => setTimeout(r, 1500));
assert.ok(!notes.some((n) => n.includes('orch2')), 'orchestrator blocks never notify');

hub.spawn({ profile: 'pm', role: 'worker', name: 'quick', task: 'T', cwd });
await until(() => hub.agents.get('quick')!.status === 'blocked');
hub.kill('quick'); // leaves blocked state before the delay
await new Promise((r) => setTimeout(r, 1300));
assert.ok(!notes.some((n) => n.includes('quick')), 'short blocked → no notification');

hub.spawn({ profile: 'pm', role: 'worker', name: 'pm', task: 'T', cwd });
await until(() => notes.some((n) => n.includes('pm izin')));
assert.equal(notes.filter((n) => n.includes('pm izin')).length, 1, 'long blocked → one notification');
// Same worker+state again within 5 min → suppressed.
const ag: any = hub.agents.get('pm')!;
ag.emit('status', 'running'); ag.emit('status', 'blocked');
await new Promise((r) => setTimeout(r, 1300));
assert.equal(notes.filter((n) => n.includes('pm izin')).length, 1, 'repeat within 5 min → none');

console.log('notify test OK');
for (const id of [...hub.order]) hub.kill(id);
process.exit(0);
