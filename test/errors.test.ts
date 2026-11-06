// Real screens of non-Claude CLIs that can't work (captured by running them as coban workers), and the
// launch tweaks that let them reach coban's socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentError, waitingForAnswer } from '../src/agent.ts';
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

test('launchFor: codex gets socket access, opencode may run coban, explicit choices are kept', () => {
  const codex = launchFor({ id: 'codex', title: 'Codex', cmd: 'codex' });
  assert.deepEqual(codex.args, ['--sandbox workspace-write', '-c sandbox_workspace_write.network_access=true']);
  assert.deepEqual(launchFor({ id: 'c', title: 'C', cmd: 'codex --sandbox danger-full-access' }).args, []);
  assert.deepEqual(launchFor({ id: 'c', title: 'C', cmd: 'codex --full-auto' }).args, []);
  const oc = launchFor({ id: 'opencode', title: 'OpenCode', cmd: 'opencode' });
  assert.deepEqual(JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT), { permission: { bash: { 'coban *': 'allow' } } });
  assert.deepEqual(launchFor({ id: 'o', title: 'O', cmd: 'opencode', env: { OPENCODE_CONFIG_CONTENT: '{}' } }).env, {});
  assert.deepEqual(launchFor({ id: 'h1', title: 'H1', cmd: "claude --allowedTools 'Bash(coban:*)'" }), { args: [], env: {} });
});
