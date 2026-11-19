import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, formatDoctor, doctorFailed } from '../src/doctor.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coban-doctor-'));
const st = (cs: any[], name: string) => cs.find((c) => c.name === name)?.status;

test('doctor: healthy config, claude dir with login trace, absent socket', async () => {
  const d = tmp();
  const cfgDir = path.join(d, 'acc'); fs.mkdirSync(cfgDir); fs.writeFileSync(path.join(cfgDir, '.claude.json'), '{}');
  const cfg = path.join(d, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ orchestrator: 'h1', profiles: [{ id: 'h1', title: 'H1', cmd: 'claude --x', env: { CLAUDE_CONFIG_DIR: cfgDir } }] }));
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const cs = await runDoctor({ configPath: cfg, sock: path.join(d, 's.sock'), env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH } });
  assert.equal(st(cs, 'config'), 'ok');
  assert.equal(st(cs, 'profil h1'), 'ok');
  assert.equal(st(cs, 'profil h1 giriş'), 'ok');
  assert.equal(st(cs, 'socket'), 'ok');
  assert.equal(doctorFailed(cs), false);
  assert.match(formatDoctor(cs), /^✓ node/);
});

test('doctor: failures — old node, bad config, missing cmd, stale socket', async () => {
  const d = tmp();
  const cfg = path.join(d, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ orchestrator: 'zz', profiles: [{ id: 'a', title: 'A', cmd: 'definitely-not-a-cli' }] }));
  const sock = path.join(d, 's.sock'); fs.writeFileSync(sock, '');   // plain file: nothing listens
  const cs = await runDoctor({ configPath: cfg, sock, nodeVersion: '20.1.0' });
  assert.equal(st(cs, 'node'), 'fail');
  assert.equal(st(cs, 'config'), 'fail');
  assert.equal(st(cs, 'socket'), 'warn');
  assert.equal(doctorFailed(cs), true);

  fs.writeFileSync(cfg, JSON.stringify({ orchestrator: 'a', profiles: [{ id: 'a', title: 'A', cmd: 'definitely-not-a-cli' }] }));
  const cs2 = await runDoctor({ configPath: cfg, sock: path.join(d, 'none') });
  assert.equal(st(cs2, 'profil a'), 'fail');
  fs.writeFileSync(cfg, '{nope');
  assert.equal(st(await runDoctor({ configPath: cfg, sock: path.join(d, 'none') }), 'config'), 'fail');
});
