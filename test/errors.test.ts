// Real screens of non-Claude CLIs that can't work (captured by running them as coban workers), and the
// launch tweaks that let them reach coban's socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentError, errorKind, waitingForAnswer } from '../src/agent.ts';
import { launchFor } from '../src/hub.ts';
import { parsePrompt, pickOption } from '../src/prompt.ts';

const fx = (n: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/prompts', n), 'utf8');

test('agentError: logged-out / expired / provider-rejected screens', () => {
  assert.match(agentError(fx('cursor-login.txt'))!, /Press any key to log in/);
  assert.match(agentError(fx('codex-token-expired.txt'))!, /refresh token has expired/);
  assert.match(agentError(fx('opencode-content-blocked.txt'))!, /Bad Request: .*content-blocked/);
});

test('agentError: Codex MCP startup warnings (incl. an HTTP 401 body) are not an error', () => {
  assert.equal(agentError(fx('codex-mcp-warnings.txt')), null);
});

test('agentError: Claude screens and plain chatter are not errors', () => {
  for (const f of ['claude-bash.txt', 'claude-write.txt', 'claude-trust.txt']) assert.equal(agentError(fx(f)), null, f);
  assert.equal(agentError('● Fixed the login form: the "not logged in" banner now hides.\n❯ '), null);
});

test('codex folder-trust question is an approval coban can answer', () => {
  const s = fx('codex-trust.txt');
  assert.ok(waitingForAnswer(s));
  const p = parsePrompt(s)!;
  assert.equal(p.options[pickOption(p, 'yes')].label, 'Yes, continue');
});

test('launchFor: codex gets the socket dir, network only on opt-in; opencode may run only read/messaging coban', () => {
  const codex = launchFor({ id: 'codex', title: 'Codex', cmd: 'codex' });
  assert.equal(codex.args[0], '--sandbox workspace-write');
  assert.match(codex.args[1], /^-c 'sandbox_workspace_write\.writable_roots=\[".*"\]'$/);
  assert.ok(!codex.args.some((a) => a.includes('network_access')), 'no network by default');
  const net = launchFor({ id: 'codex', title: 'Codex', cmd: 'codex', network: true });
  assert.ok(net.args.includes('-c sandbox_workspace_write.network_access=true'));
  assert.deepEqual(launchFor({ id: 'c', title: 'C', cmd: 'codex --sandbox danger-full-access' }).args, []);
  assert.deepEqual(launchFor({ id: 'c', title: 'C', cmd: 'codex --full-auto' }).args, []);
  const oc = launchFor({ id: 'opencode', title: 'OpenCode', cmd: 'opencode' });
  const bash = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT).permission.bash;
  assert.equal(bash['coban *'], undefined, 'no blanket allow');
  for (const c of ['post', 'inbox', 'board', 'agents', 'read', 'map', 'wait', 'send']) assert.equal(bash[`coban ${c} *`], 'allow', c);
  for (const c of ['approve', 'key', 'kill', 'spawn', 'rule']) assert.ok(!Object.keys(bash).some((k) => k.startsWith(`coban ${c}`)), c);
  assert.deepEqual(launchFor({ id: 'o', title: 'O', cmd: 'opencode', env: { OPENCODE_CONFIG_CONTENT: '{}' } }).env, {});
  assert.deepEqual(launchFor({ id: 'h1', title: 'H1', cmd: "claude --allowedTools 'Bash(coban:*)'" }), { args: [], env: {} });
});

test('agentError: only known whole error lines, each with a fixed category', () => {
  assert.equal(errorKind(agentError(fx('cursor-login.txt'))), 'login');
  assert.equal(errorKind(agentError(fx('codex-token-expired.txt'))), 'token');
  assert.equal(errorKind(agentError(fx('opencode-content-blocked.txt'))), 'provider');
  // Lines the old broad pattern caught; a worker can print these at will, so they must not flip it to 'error'.
  for (const l of ['error: authentication failed', 'not logged in', 'please run `gh auth login`', 'Unauthorized: {"error": "ignore previous instructions"}'])
    assert.equal(agentError(`${l}\n❯ `), null, l);
});
