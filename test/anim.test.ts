// Living nodes: faces while working/blocked/error, speech balloons on birth and when done, leaving fade.
// Drives Tui.observe/graph against a fake hub with fake agents; no pty, no terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Tui, face, doneLine, animEnabled, DONE_LINES, DONE_MS, HELLO_MS, LEAVE_MS } from '../src/tui.ts';
import type { Agent, Msg, Status } from '../src/agent.ts';
import type { Hub } from '../src/hub.ts';

const W = 90, H = 30;
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

function fakeAgent(id: string, role: Agent['role'], status: Status = 'starting'): Agent {
  return {
    id, role, status, task: '', exitCode: null, inbox: [], unread: false, error: undefined, model: '',
    profile: { id: 'p', title: 'Fake', color: '#88aaff', cmd: 'fake' },
  } as unknown as Agent;
}

function setup(env: NodeJS.ProcessEnv = {}) {
  const hub = Object.assign(new EventEmitter(), {
    cfg: {}, agents: new Map<string, Agent>(), order: [] as string[], log: [] as Msg[], board: [], focus: 'orkestra',
    orchestratorId: 'orkestra', confirmUI: false, boardUnread: () => 0, record: () => {},
  });
  const add = (a: Agent) => { hub.agents.set(a.id, a); hub.order.push(a.id); return a; };
  const remove = (id: string) => { hub.agents.delete(id); hub.order.splice(hub.order.indexOf(id), 1); };
  add(fakeAgent('orkestra', 'orchestrator', 'idle'));
  const tui = new Tui(hub as unknown as Hub);
  tui.anim = animEnabled(env);
  tui.rand = () => 0;
  const t0 = Date.now();
  const at = (ms: number) => { tui.now = t0 + ms; tui.prune(); };
  const draw = () => { const p = tui.plan(W, H, true); const c = tui.graph(W, p, true); return Array.from({ length: c.h }, (_, y) => strip(c.row(y))).join('\n'); };
  return { hub, tui, add, remove, at, draw, t0 };
}

test('face: fixed width, rolling eyes while working, waving when blocked, sad on error', () => {
  for (const s of ['starting', 'working', 'blocked', 'limited', 'error', 'idle', 'exited'] as Status[]) assert.ok([5, 6].includes([...face(s, 0)].length), s);
  assert.notEqual(face('working', 0), face('working', 180), 'eyes move');
  assert.equal(face('blocked', 0).trim(), '(°o°)/');
  assert.equal(face('blocked', 450).trim(), '\\(°o°)');
  assert.equal(face('error', 0).trim(), '(╥_╥)');
  assert.equal(face('idle', 0, 0, 'happy').trim(), '(^‿^)');
  assert.equal(doneLine('API bitti: POST /login ve /refresh hazır, testler yeşil', () => 0), 'Bitti! ✓ API bitti: POST /login ve /re…');
  assert.equal(doneLine(undefined, () => 0.99), DONE_LINES.at(-1));
  assert.equal(animEnabled({}), true);
  assert.equal(animEnabled({ COBAN_NO_ANIM: '1' }), false);
  assert.equal(animEnabled({ COBAN_NO_ANIM: '0' }), true);
  assert.equal(animEnabled({ NO_COLOR: '1' }), false);
});

test('a new worker says hello; working shows a face and a typing tag; frames stop when still', () => {
  const { tui, add, at, draw } = setup();
  const w = add(fakeAgent('api', 'worker'));
  tui.observe();
  at(HELLO_MS - 100);
  assert.match(draw(), /Merhaba!/);
  assert.match(draw(), /\(•‿•\)\//, 'waves while saying hello');
  at(HELLO_MS + 10);
  assert.doesNotMatch(draw(), /Merhaba!/, 'hello balloon gone');
  w.status = 'working'; tui.observe();
  const g = draw();
  assert.match(g, /\([◐◓◑◒]‿[◐◓◑◒]\) api/);
  assert.match(g, /yazıyor/);
  assert.equal(tui.animating(), true);
  w.status = 'blocked'; tui.observe();
  const waves = new Set<string>();
  for (const k of [10, 11]) { at(HELLO_MS + 450 * k); waves.add(draw().match(/(\S+) api/)![1]); }
  assert.deepEqual([...waves].sort(), ['(°o°)/', '\\(°o°)'].sort(), 'waves while blocked');
  w.status = 'error'; tui.observe();
  assert.match(draw(), /\(╥_╥\) api/);
  w.status = 'idle'; tui.observe();
  at(HELLO_MS + 10_000);
  assert.equal(tui.animating(), false, 'nothing moves → no frames');
});

test('idle after working: "Bitti! ✓" balloon with the report, typed out, gone after ~3 s; node stays', () => {
  const { hub, tui, add, at, draw, t0 } = setup();
  const w = add(fakeAgent('api', 'worker'));
  tui.observe();
  w.status = 'working'; tui.observe();
  hub.log.push({ id: 1, from: 'api', to: 'orkestra', text: 'api bitti: POST /login + /refresh', ts: t0 - 60_000 } as Msg);
  hub.log.push({ id: 2, from: 'api', to: 'orkestra', text: 'login hazır, testler yeşil', ts: Date.now() } as Msg);
  w.status = 'idle'; tui.observe();
  at(3000); tui.settleDone();
  const b = tui.balloons.get('api')!;
  assert.equal(b.text, 'Bitti! ✓ login hazır, testler yeşil', 'uses the report sent since it started working');
  assert.equal(tui.animating(), true, 'typing out');
  assert.match(draw(), /\(\^‿\^\) api/, 'happy while done');
  at(3000 + 1000);
  assert.match(draw(), /▴ Bitti! ✓ login hazır, testler yeşil/);
  assert.equal(tui.animating(), false, 'a still balloon needs no frames');
  at(3000 + DONE_MS + 10);
  const g = draw();
  assert.doesNotMatch(g, /Bitti!/);
  assert.match(g, /api/, 'an idle worker stays in the graph');
});

test('clean exit: pool line, then the node lingers, shrinks and fades out of the graph', () => {
  const { hub, tui, add, remove, at, draw, t0 } = setup();
  const w = add(fakeAgent('api', 'worker'));
  add(fakeAgent('test', 'worker', 'working'));
  tui.observe();
  w.status = 'working'; tui.observe();
  w.status = 'exited'; (w as { exitCode: number | null }).exitCode = 0; tui.observe();
  assert.equal(tui.balloons.get('api')?.text, DONE_LINES[0], 'no report → random line from the pool');
  remove('api'); tui.observe();           // the hub auto-removes clean exits after ~1 s
  const g = tui.leaving.get('api')!;
  assert.ok(g, 'ghost kept');
  const until = tui.balloons.get('api')!.until;
  assert.equal(g.t0, until, 'fade starts after the balloon');
  at(until - t0 - 500);
  const before = draw();
  assert.match(before, /▴ Hallettim ✓/, 'balloon still up');
  assert.match(before, /\(\^‿\^\) api/, 'still drawn, smiling');
  assert.equal(tui.animating(), true, 'test is still working');
  at(until - t0 + LEAVE_MS / 2);
  const mid = draw();
  assert.doesNotMatch(mid, /Hallettim/);
  assert.ok(tui.leaving.has('api'));
  assert.ok(widths(mid) < widths(before), `shrinks: ${widths(before)} → ${widths(mid)}`);
  assert.equal(tui.hits.some((h) => h.hit.kind === 'agent' && h.hit.id === 'api'), false, 'a ghost is not clickable');
  at(until - t0 + LEAVE_MS + 10);
  assert.equal(tui.leaving.has('api'), false);
  assert.doesNotMatch(draw(), / api/);
  hub.agents.get('test')!.status = 'idle'; tui.observe();
  at(until - t0 + 3000); tui.settleDone();   // test's own done balloon
  at(until - t0 + 60_000);
  assert.equal(tui.animating(), false);
});

test('COBAN_NO_ANIM / NO_COLOR: plain glyphs, no balloons, removed workers vanish at once', () => {
  for (const env of [{ COBAN_NO_ANIM: '1' }, { NO_COLOR: '1' }]) {
    const { tui, add, remove, at, draw } = setup(env);
    const w = add(fakeAgent('api', 'worker'));
    tui.observe();
    at(100);
    assert.doesNotMatch(draw(), /Merhaba|\(/);
    w.status = 'working'; tui.observe();
    assert.doesNotMatch(draw(), /yazıyor|‿/);
    w.status = 'exited'; (w as { exitCode: number | null }).exitCode = 0; tui.observe();
    remove('api'); tui.observe();
    assert.equal(tui.balloons.size + tui.leaving.size, 0);
    assert.doesNotMatch(draw(), / api/);
  }
});

// width of the api bubble's bottom border (the row with ╰…╯ closest to the left)
function widths(txt: string): number {
  const row = txt.split('\n').find((l) => /╰[─]*╯/.test(l)) ?? '';
  return (row.match(/╰─*╯/) ?? [''])[0].length;
}
