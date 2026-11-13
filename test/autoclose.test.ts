// Run: node --disable-warning=ExperimentalWarning test/autoclose.test.ts
// Closed/clean-exit workers and manual agents are removed shortly after, 130/143 are not crashes; real crashes still hand off; orchestrator stays.
import assert from 'node:assert/strict';
import os from 'node:os';
import { Hub } from '../src/hub.ts';
import type { Config } from '../src/config.ts';

const sh = (s: string) => `sh -c '${s}'`;
const cfg: Config = {
  orchestrator: 'o',
  profiles: [
    { id: 'o', title: 'orch', cmd: sh('sleep 1; exit 130'), promptArg: '' },
    { id: 'a', title: 'A', cmd: sh('exit 130'), promptArg: '' },
    { id: 'c', title: 'C', cmd: sh('exit 3'), promptArg: '' },
    { id: 'b', title: 'B', cmd: sh('sleep 30'), promptArg: '' },
  ],
};
const hub = new Hub(cfg);
hub.autoRemoveMs = 300;
const handoffs: any[] = [];
hub.on('handoff', (h) => handoffs.push(h));
const cwd = os.tmpdir();
const until = async (f: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); }
};

hub.spawn({ profile: 'o', role: 'orchestrator' });
hub.spawn({ profile: 'b', role: 'worker', name: 'keep', task: 'T', cwd });
hub.spawn({ profile: 'a', role: 'worker', name: 'w', task: 'T', cwd });
hub.spawn({ profile: 'a', role: 'manual', name: 'm' });
await until(() => !hub.agents.has('w') && !hub.agents.has('m'));
assert.equal(handoffs.length, 0, 'kullanıcı kapattığı işçi 130 ile çıkınca devir açılmaz');
assert.ok(hub.agents.has('keep'));

// Orchestrator exits 130: stays, status exited.
await until(() => hub.agents.get('orkestra')?.status === 'exited');
await new Promise((r) => setTimeout(r, 800));
assert.ok(hub.agents.has('orkestra'), 'orchestrator is not auto-removed');

// Real crash still hands off.
hub.spawn({ profile: 'c', role: 'worker', name: 'boom', task: 'HEDEF: x', cwd });
await until(() => handoffs.length > 0);
assert.equal(handoffs[0].from, 'boom');

console.log('autoclose test OK');
for (const id of [...hub.order]) hub.kill(id);
process.exit(0);
