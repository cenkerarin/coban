// Standing approval rules (`coban rule`): anchored regex, cwd/profile scoping, no rules by default, user-only edits.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startCoban, until, sleep, type Coban } from './helpers.ts';
import { ruleMatches } from '../src/config.ts';

let c: Coban | undefined;
after(async () => { await c?.stop(); });

test('ruleMatches: the regex must match the whole text, cwd and profile narrow it', () => {
  const text = 'Remove the build folder · rm -rf build';
  assert.ok(ruleMatches({ match: 'Remove the build folder · rm -rf build' }, text, '/w', 'h1'));
  assert.ok(ruleMatches({ match: '.* · rm -rf build' }, text, '/w', 'h1'));
  assert.ok(!ruleMatches({ match: 'rm -rf build' }, text, '/w', 'h1'), 'a partial match is no match');
  assert.ok(!ruleMatches({ match: '(' }, text, '/w', 'h1'), 'an invalid regex never matches');
  const r = { match: '.*', cwd: '/w/proj', profile: 'h1' };
  assert.ok(ruleMatches(r, text, '/w/proj', 'h1'));
  assert.ok(ruleMatches(r, text, '/w/proj/sub', 'h1'));
  assert.ok(!ruleMatches(r, text, '/w/project', 'h1'), 'sibling directory with the same prefix');
  assert.ok(!ruleMatches(r, text, '/w/proj', 'h2'));
});

test('no rules by default; rule add/list/rm; auto-approve; agents cannot add rules', async () => {
  c = await startCoban();
  c.write('\r'); await sleep(300); c.write('1');
  await until(async () => (await c!.cli('', 'agents')).includes('★'));
  const cfgRules = () => JSON.parse(fs.readFileSync(path.join(c!.dir, 'config.json'), 'utf8')).rules;

  assert.equal(await c.cli('', 'rule', 'list'), '(kural yok)');
  await c.cli('orkestra', 'spawn', 'fake', 'temizle MENU', '--name', 'm1');
  await until(async () => /^m1 .*blocked/m.test(await c!.cli('', 'agents')));
  await sleep(1500);
  assert.match(await c.cli('', 'agents'), /^m1 .*blocked/m, 'nothing is approved without a rule');

  // a rule that only matches part of the text does nothing; an agent may not add rules at all
  assert.match(await c.cli('', 'rule', 'add', 'rm -rf build'), /kural #1 eklendi/);
  assert.match(await c.cli('orkestra', 'rule', 'add', '.*'), /ERR .*yalnız kullanıcıdan/);
  assert.match(await c.cli('', 'rule', 'add', '('), /ERR/);
  await sleep(1500);
  assert.match(await c.cli('', 'agents'), /^m1 .*blocked/m, 'a partial regex does not approve');

  // the exact text, scoped to a profile and the working directory
  assert.match(await c.cli('', 'rule', 'add', 'Remove the build folder · rm -rf build', '--profile', 'fake', '--cwd', fs.realpathSync(c.dir)), /kural #2 eklendi/);
  await until(async () => (await c!.cli('', 'read', 'm1')).includes('chose: Yes'));   // plain "Yes", never "always"
  assert.ok(!(await c.cli('', 'read', 'm1')).includes("chose: Yes, and"));
  assert.match(await c.cli('', 'board'), /kural #2 ile otomatik onaylandı: m1/);
  assert.equal(cfgRules().length, 2, 'rules are saved in the config');
  assert.match(await c.cli('', 'rule', 'list'), /^2 {2}\/Remove the build folder · rm -rf build\/ {2}cwd=.* {2}profil=fake$/m);

  assert.match(await c.cli('', 'rule', 'rm', '1'), /kural silindi: rm -rf build/);
  assert.match(await c.cli('', 'rule', 'rm', '9'), /ERR .*böyle bir kural yok/);
  assert.equal(cfgRules().length, 1);

  // a rule for another directory does not apply
  assert.match(await c.cli('', 'rule', 'rm', '1'), /kural silindi/);
  await c.cli('', 'rule', 'add', 'Remove the build folder · rm -rf build', '--cwd', '/nonexistent');
  await c.cli('orkestra', 'spawn', 'fake', 'yine MENU', '--name', 'm2');
  await until(async () => /^m2 .*blocked/m.test(await c!.cli('', 'agents')));
  await sleep(1500);
  assert.match(await c.cli('', 'agents'), /^m2 .*blocked/m);
});

test('the panel layout (feed hidden) is saved and restored', async () => {
  await c?.stop();
  c = await startCoban(180, 46);
  const saved = () => JSON.parse(fs.readFileSync(path.join(c!.dir, 'config.json'), 'utf8')).feedHidden;
  c.write('\r'); await sleep(300); c.write('1');
  await until(() => c!.screen().includes('SOHBET'));
  c.write('\x02l');
  await until(() => saved() === true);
  c.write('\x02l');
  await until(() => saved() === false);
  await c.stop();
  // starts hidden (from the config): one toggle shows the feed again and saves `false`
  c = await startCoban(180, 46, undefined, { feedHidden: true });
  c.write('\r'); await sleep(300); c.write('1');
  await until(() => c!.screen().includes('SOHBET'));
  c.write('\x02l');
  await until(() => saved() === false);
});
