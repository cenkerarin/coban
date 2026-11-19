// Plan mode: pure validation (ids, profiles, after graph, conflict warnings), the hub's plan RPCs and their rights,
// and end to end: `coban plan` → PLAN line and dashed nodes in the TUI → ^b p starts the workers / ^b P drops it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { planDepths, planSummary, topoOrder, validatePlan } from '../src/plan.ts';
import { Hub } from '../src/hub.ts';
import { fakeProfile, ROOT, sleep, startCoban, until, type Coban } from './helpers.ts';

const env = { profiles: ['h1', 'h2'], agents: ['orkestra', 'w0'], reserved: ['user', 'all', 'coban', 'anon'] };
const node = (id: string, extra: object = {}) => ({ id, profile: 'h1', task: `iş ${id}`, ...extra });
const errs = (plan: unknown) => validatePlan(plan, env).errors.join('\n');
const warns = (nodes: object[]) => validatePlan({ title: 't', nodes }, env).warnings;

test('validatePlan: valid graph, topological order, cleaned copy', () => {
  const r = validatePlan({ title: ' Plan\u0007\n A ', nodes: [node('c', { after: ['a', 'b'] }), node('a'), node('b', { after: ['a', 'w0', 'a'], ctx: ['x.ts'], worktree: false })] }, env);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.order, ['a', 'b', 'c']);
  assert.equal(r.plan!.title, 'Plan A', 'control characters and line breaks are flattened');
  const b = r.plan!.nodes[2];
  assert.deepEqual(b, { id: 'b', profile: 'h1', task: 'iş b', after: ['a', 'w0'] }, 'ctx, worktree:false and duplicate after dropped');
  assert.deepEqual(Object.fromEntries(planDepths(r.plan!.nodes)), { a: 0, b: 1, c: 2 });
  assert.equal(topoOrder([{ id: 'x', after: ['y'] }, { id: 'y', after: ['x'] }]), null);
  assert.equal(planSummary(r.plan!, ['w']), 'Plan A · 3 iş: c(h1)←a,b a(h1) b(h1)←a,w0 · 1 uyarı');
});

test('validatePlan: errors', () => {
  assert.match(errs([]), /JSON nesnesi/);
  assert.match(errs({ nodes: [node('a')] }), /title gerekli/);
  assert.match(errs({ title: 't', nodes: [] }), /nodes boş olmayan/);
  assert.match(errs({ title: 't', nodes: [node('a'), node('a')] }), /\(a\): id tekrar ediyor/);
  assert.match(errs({ title: 't', nodes: [node('../x')] }), /geçersiz id/);
  assert.match(errs({ title: 't', nodes: [node('coban')] }), /ayrılmış/);
  assert.match(errs({ title: 't', nodes: [node('w0')] }), /"w0" adlı bir agent zaten var/);
  assert.match(errs({ title: 't', nodes: [node('a', { profile: 'yok' })] }), /bilinmeyen profil "yok" \(var olanlar: h1, h2\)/);
  assert.match(errs({ title: 't', nodes: [node('a', { task: ' ' })] }), /task gerekli/);
  assert.match(errs({ title: 't', nodes: [node('a', { after: 'b' })] }), /after id dizisi/);
  assert.match(errs({ title: 't', nodes: [node('a', { after: ['zz'] })] }), /after "zz" ne planda ne de mevcut bir agent/);
  assert.match(errs({ title: 't', nodes: [node('a', { after: ['a'] })] }), /kendine bağımlı/);
  assert.match(errs({ title: 't', nodes: [node('a', { after: ['c'] }), node('b', { after: ['a'] }), node('c', { after: ['b'] }), node('d', { after: ['c'] }), node('e')] }), /after döngüsü: a, b, c, d$/);
  assert.match(errs({ title: 't', nodes: [node('a', { worktree: '--evil' })] }), /worktree/);
  assert.match(errs({ title: 't', nodes: [node('a', { files: 'x.ts' })] }), /files/);
  assert.match(errs({ title: 't', nodes: [node('a', { files: ['x\u001b[2J'] })] }), /files/);
  assert.equal(errs({ title: 't', nodes: [node('a', { after: ['w0'], worktree: 'feat/x', verify: 'npm test', files: ['a.ts'] })] }), '');
});

test('validatePlan: conflict warning only for unordered nodes writing the same path in one checkout', () => {
  const w = warns([node('a', { files: ['src/x.ts'] }), node('b', { files: ['./src/x.ts', 'y.ts'] })]);
  assert.equal(w.length, 1);
  assert.match(w[0], /çakışma: a ↔ b aynı dosyaya yazıyor \(src\/x\.ts\)/);
  // ordered through after (also transitively): no warning
  assert.deepEqual(warns([node('a', { files: ['x.ts'] }), node('b', { after: ['a'] }), node('c', { after: ['b'], files: ['x.ts'] })]), []);
  // one of them in its own worktree: separate checkouts, no warning
  assert.deepEqual(warns([node('a', { files: ['x.ts'] }), node('b', { files: ['x.ts'], worktree: true })]), []);
  assert.deepEqual(warns([node('a', { files: ['x.ts'], worktree: 'feat/a' }), node('b', { files: ['x.ts'], worktree: true })]), []);
  // a directory covers the files below it; disjoint files don't conflict
  assert.equal(warns([node('a', { files: ['src/'] }), node('b', { files: ['src/hub.ts'] }), node('c', { files: ['README.md'] })]).length, 1);
  // siblings both after the same node still race each other
  assert.equal(warns([node('a'), node('b', { after: ['a'], files: ['x.ts'] }), node('c', { after: ['a'], files: ['x.ts'] })]).length, 1);
});

// ── hub: rights, replace, approve (spawn + queue), reject ──
const hub = new Hub({ orchestrator: 'fake', profiles: [fakeProfile()] });
const pending = (h: Hub) => h.plan;   // asserts narrow hub.plan; read it through a call
let c: Coban | undefined;
after(async () => { for (const id of [...hub.order]) hub.kill(id); for (const j of [...hub.queue]) hub.kill(j.id); await c?.stop(); });

test('hub: only the user/orchestrator propose, only the user decides; approve spawns and queues, reject drops', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-plan-'));
  const orch = hub.spawn({ profile: 'fake', role: 'orchestrator' });
  hub.spawn({ profile: 'fake', role: 'worker', name: 'w', task: 'x', cwd });
  const plan = { title: 'P', cwd, nodes: [{ id: 'a', profile: 'fake', task: 'iş a' }, { id: 'b', profile: 'fake', task: 'iş b', after: ['a', 'w'] }] };

  await assert.rejects(hub.handle('w', 'plan_set', plan), /yalnız kullanıcıdan veya orkestratörden/);
  await assert.rejects(hub.handle('anon', 'plan_set', plan), /yalnız kullanıcıdan veya orkestratörden/);
  await assert.rejects(hub.handle(orch.id, 'plan_set', { ...plan, nodes: [{ id: 'w', profile: 'fake', task: 't' }] }), /plan geçersiz: .*"w" adlı bir agent zaten var/);
  assert.equal(hub.plan, undefined);

  assert.deepEqual(await hub.handle(orch.id, 'plan_set', { ...plan, title: 'eski' }), { title: 'eski', n: 2, warnings: [] });
  assert.deepEqual(await hub.handle(orch.id, 'plan_set', plan), { title: 'P', n: 2, warnings: [], replaced: 'eski' }, 'one plan at a time');
  assert.equal(hub.plan!.from, orch.id);
  const shown: any = await hub.handle('w', 'plan_show', {});
  assert.equal(shown.plan.summary, 'P · 2 iş: a(fake) b(fake)←a,w');

  for (const who of [orch.id, 'w', 'anon']) {
    await assert.rejects(hub.handle(who, 'plan_approve', {}), /yalnız kullanıcıdan/);
    await assert.rejects(hub.handle(who, 'plan_reject', {}), /yalnız kullanıcıdan/);
  }
  assert.ok(hub.plan, 'still pending');

  const r: any = await hub.handle('user', 'plan_approve', {});
  assert.deepEqual(r, { title: 'P', started: ['a'], queued: ['b (← a, w)'], failed: [] });
  assert.equal(hub.plan, undefined);
  assert.ok(hub.agents.has('a') && hub.agents.get('a')!.cwd === cwd);
  assert.ok(hub.queue.some((j) => j.id === 'b' && j.after.join() === 'a,w'), 'b waits in the queue');
  assert.ok(hub.log.some((m) => m.from === 'coban' && m.to === orch.id && m.text === 'plan onaylandı, başladı: a · kuyrukta: b (← a, w)'));

  hub.setPlan({ title: 'R', cwd, nodes: [{ id: 'r1', profile: 'fake', task: 'x' }] });
  assert.deepEqual(hub.rejectPlan(), { title: 'R' });
  assert.ok(!hub.agents.has('r1') && hub.plan === undefined);
  assert.ok(hub.log.some((m) => m.to === orch.id && m.text.startsWith('plan reddedildi: R')));
  assert.throws(() => hub.rejectPlan(), /bekleyen plan yok/);
  assert.throws(() => hub.approvePlan(), /bekleyen plan yok/);

  // proposed while free, taken before the approval: refused, the plan stays for the user to reject
  hub.setPlan({ title: 'S', cwd, nodes: [{ id: 's1', profile: 'fake', task: 'x' }] });
  hub.spawn({ profile: 'fake', role: 'worker', name: 's1', task: 'x', cwd });
  assert.throws(() => hub.approvePlan(), /plan artık geçerli değil: .*"s1" adlı bir agent zaten var/);
  assert.equal(pending(hub)?.title, 'S');
});

test('hub: a decision is bound to the plan the user saw — a plan swapped in meanwhile is not approved', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-plan-'));
  const one = (title: string, id: string) => ({ title, cwd, nodes: [{ id, profile: 'fake', task: 'x' }] });
  hub.setPlan(one('A', 'ta'));
  const seenA = hub.plan!.seq;
  hub.setPlan(one('B', 'tb'));
  assert.throws(() => hub.approvePlan(seenA), /plan bu arada değişti \(şimdi: "B"\)/);
  assert.throws(() => hub.rejectPlan(seenA), /bu arada değişti/);
  assert.equal(hub.plan!.title, 'B');

  // outside terminal (anon): the box shows the pending plan; replaced while it is open → the yes doesn't carry over
  hub.confirmUI = true;
  try {
    const decision = hub.handle('anon', 'plan_approve', { seq: 999 });   // a seq the client states is ignored
    await until(() => hub.confirms.length === 1, 2000, 10);
    assert.ok(hub.confirms[0].lines.some((l) => l.includes('B · 1 iş: tb(fake)')), hub.confirms[0].lines.join('\n'));
    hub.setPlan(one('C', 'tc'));
    hub.resolveConfirm(hub.confirms[0].id, true);
    await assert.rejects(decision, /plan bu arada değişti \(şimdi: "C"\)/);
    assert.ok(!hub.agents.has('tb') && !hub.agents.has('tc') && pending(hub)?.title === 'C');
  } finally { hub.confirmUI = false; }
  hub.rejectPlan();
});

// ── end to end: the real TUI ──
const run = (args: string[], input: string, e: Record<string, string>, cwd: string) => new Promise<string>((resolve) => {
  const p = execFile(path.join(ROOT, 'bin', 'coban'), args, { cwd, encoding: 'utf8', env: e }, (err, so, se) => resolve(err ? `ERR ${se}` : so.trimEnd()));
  p.stdin!.end(input);
});

test('e2e: coban plan → PLAN line, dashed nodes and warning → ^b p starts them; stdin plan → ^b P rejects', async () => {
  c = await startCoban();
  c.write('\r'); await sleep(300); c.write('1');
  await until(async () => (await c!.cli('', 'agents')).includes('★'));
  fs.writeFileSync(path.join(c.dir, 'ctx.ts'), 'export function hello() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(c.dir, 'plan.json'), JSON.stringify({
    title: 'Demo plan', nodes: [
      { id: 'pa', profile: 'fake', task: 'iş a', files: ['src/x.ts'], ctx: ['ctx.ts#hello'] },
      { id: 'pb', profile: 'fake', task: 'iş b', files: ['src/x.ts'] },
      { id: 'pc', profile: 'fake', task: 'iş c', after: ['pa', 'pb'] },
    ],
  }));
  const out = await c.cli('orkestra', 'plan', 'plan.json');
  assert.match(out, /^plan gönderildi: Demo plan · 3 iş — kullanıcının onayı bekleniyor/);
  assert.match(out, /\n⚠ çakışma: pa ↔ pb aynı dosyaya yazıyor \(src\/x\.ts\)/);

  await until(() => c!.screen().includes('PLAN: Demo plan · 3 iş · ^b p onayla · ^b P reddet · ⚠ 1 uyarı'));
  await until(() => /┆ +pc +┆/.test(c!.screen()));   // dashed node boxes, drawn in the graph column
  const s = c.screen();
  assert.match(s, /PLAN: Demo plan · 3 iş · öneren orkestra/);
  assert.match(s, /┆ +pa +┆.*┆ +pb +┆/);
  assert.match(s, /┰/, 'after edges leave the parents');
  assert.match(s, /⚠ çakışma: pa ↔ pb/);
  assert.equal(await c.cli('orkestra', 'plan', '--show'), 'PLAN: Demo plan · 3 iş: pa(fake) pb(fake) pc(fake)←pa,pb · 1 uyarı · öneren orkestra · onay bekliyor');
  assert.doesNotMatch(await c.cli('', 'agents'), /^p[abc] /m, 'nothing starts before the approval');

  await sleep(700);   // ^b p only acts on a plan that has been on screen a moment
  c.write('\x02p');
  await until(async () => /^pa .*"iş a İLGİLİ KOD/m.test(await c!.cli('', 'agents')), 10000);   // ctx went into the task
  await until(() => !c!.screen().includes('PLAN: Demo plan'));
  assert.match(await c.cli('', 'log'), /coban→orkestra: plan onaylandı, başladı: pa, pb · kuyrukta: pc \(← pa, pb\)/);
  await until(async () => /^pc /m.test(await c!.cli('', 'agents')), 15000);   // the queue starts pc once pa and pb are done

  // a plan from stdin (human terminal: confirmed in the window), then rejected with ^b P
  const plan2 = JSON.stringify({ title: 'İkinci', nodes: [{ id: 'qa', profile: 'fake', task: 'iş q' }] });
  assert.match(await c.confirming(run(['plan', '-'], plan2, c.env, c.dir)), /^plan gönderildi: İkinci · 1 iş/);
  await until(() => c!.screen().includes('PLAN: İkinci · 1 iş'));
  await sleep(700);
  c.write('\x02P');
  await until(() => !c!.screen().includes('PLAN: İkinci'));
  assert.match(await c.cli('', 'log'), /coban→orkestra: plan reddedildi: İkinci/);
  assert.equal(await c.cli('', 'plan', '--show'), '(bekleyen plan yok)');
  assert.doesNotMatch(await c.cli('', 'agents'), /^qa /m);
});
