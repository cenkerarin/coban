import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextAccount, DEFAULT_CONFIG } from '../src/config.ts';

test('nextAccount picks the first free hN and its own config dir', () => {
  const cfg = { ...DEFAULT_CONFIG, profiles: DEFAULT_CONFIG.profiles.filter((p) => p.id !== 'h2') };
  const { profile, dir } = nextAccount(cfg);
  assert.equal(profile.id, 'h2');
  assert.match(dir, /\.claude-hesap2$/);
  assert.equal(profile.env?.CLAUDE_CONFIG_DIR, '~/.claude-hesap2');
  assert.equal(nextAccount(DEFAULT_CONFIG).profile.id, 'h4');
});
