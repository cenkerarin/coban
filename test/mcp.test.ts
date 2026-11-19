import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMcpServers, McpWatch, type McpServer } from '../src/mcp.ts';

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coban-mcp-'));
  const home = path.join(root, 'home'), cfg = path.join(root, 'cfg'), cwd = path.join(root, 'proj'), bin = path.join(root, 'bin');
  for (const d of [home, cfg, cwd, bin]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'goodcmd'), '#!/bin/sh\n', { mode: 0o755 });
  return { root, home, cfg, cwd, bin, env: { PATH: bin } as NodeJS.ProcessEnv };
}
const w = (f: string, v: unknown) => fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
const by = (l: McpServer[]) => Object.fromEntries(l.map((x) => [x.name, x]));

test('reads profile config + project + .mcp.json; ok / disabled / missing command', () => {
  const t = tmp();
  const SECRET = 'sk-SECRET-TOKEN-123';
  w(path.join(t.cfg, '.claude.json'), {
    mcpServers: { fs: { command: 'goodcmd', env: { TOKEN: SECRET } }, gone: { command: 'nope-not-here' }, off: { command: 'goodcmd', disabled: true }, web: { url: 'https://x.example/mcp', headers: { Authorization: SECRET } }, bad: { url: 'not a url' } },
    projects: { [t.cwd]: { mcpServers: { proj: { command: 'goodcmd' } }, disabledMcpjsonServers: ['pj-off'] } },
  });
  w(path.join(t.cwd, '.mcp.json'), { mcpServers: { pj: { command: 'goodcmd' }, 'pj-off': { command: 'goodcmd' } } });
  const r = by(readMcpServers(t.cfg, t.cwd, { home: t.home, env: t.env }));
  assert.equal(r.fs.ok, true);
  assert.equal(r.gone.ok, false); assert.match(r.gone.reason, /komut yok/);
  assert.equal(r.off.ok, false); assert.equal(r.off.reason, 'disabled');
  assert.equal(r.web.ok, true);
  assert.equal(r.bad.ok, false);
  assert.equal(r.proj.ok, true);
  assert.equal(r.pj.ok, true);
  assert.equal(r['pj-off'].reason, 'disabled');
  assert.ok(!JSON.stringify(r).includes(SECRET), 'secrets must never surface');
});

test('broken, missing or odd JSON yields an empty list, never throws', () => {
  const t = tmp();
  assert.deepEqual(readMcpServers(t.cfg, t.cwd, { home: t.home, env: t.env }), []);
  w(path.join(t.cfg, '.claude.json'), '{ not json');
  w(path.join(t.cwd, '.mcp.json'), '[1,2');
  assert.deepEqual(readMcpServers(t.cfg, t.cwd, { home: t.home, env: t.env }), []);
  w(path.join(t.cfg, '.claude.json'), { mcpServers: 5, projects: [] });
  assert.deepEqual(readMcpServers(t.cfg, t.cwd, { home: t.home, env: t.env }), []);
  w(path.join(t.cfg, '.claude.json'), { mcpServers: { a: null, b: 3, c: {} } });
  assert.deepEqual(readMcpServers(t.cfg, t.cwd, { home: t.home, env: t.env }).map((s) => s.ok), [false, false, false]);
});

test('default profile also reads ~/.claude.json', () => {
  const t = tmp();
  w(path.join(t.home, '.claude.json'), { mcpServers: { g: { command: 'goodcmd' } } });
  assert.deepEqual(readMcpServers('', t.cwd, { home: t.home, env: t.env }).map((s) => s.name), ['g']);
  assert.deepEqual(readMcpServers(t.cfg, t.cwd, { home: t.home, env: t.env }), []); // separate profile dir: not mixed in
});

test('McpWatch re-reads only when files change', async () => {
  const t = tmp();
  const f = path.join(t.cfg, '.claude.json');
  w(f, { mcpServers: { a: { command: 'goodcmd' } } });
  const m = new McpWatch(t.cfg, t.cwd, { home: t.home, env: t.env });
  assert.equal(m.refresh(), true);
  assert.equal(m.refresh(), false);
  w(f, { mcpServers: { a: { command: 'goodcmd' }, b: { command: 'goodcmd' } } });
  assert.equal(m.refresh(), true);
  assert.deepEqual(m.servers.map((s) => s.name), ['a', 'b']);
  assert.equal(m.refresh(), false);
});
