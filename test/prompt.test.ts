// Permission prompts parsed from real Claude Code screens (test/fixtures/prompts, captured from v2.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePrompt, pickOption, answerKeys } from '../src/prompt.ts';

const fx = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'prompts', name), 'utf8');
const DOWN = '\x1b[B', UP = '\x1b[A';

test('Bash command prompt', () => {
  const p = parsePrompt(fx('claude-bash.txt'))!;
  assert.equal(p.title, 'Bash command');
  assert.deepEqual(p.body, ['Create empty b.txt file', 'touch b.txt']);
  assert.equal(p.question, 'Do you want to proceed?');
  assert.deepEqual(p.options.map((o) => o.label), [
    'Yes',
    'Yes, and always allow access to /tmp/demo from this project',
    'Yes, and switch to auto mode · auto mode handles these prompts for you',
    'No',
  ]);
  assert.equal(p.options.findIndex((o) => o.selected), 0);
  assert.equal(pickOption(p, 'yes'), 0);
  assert.equal(pickOption(p, 'always'), 1, 'never the auto-mode switch');
  assert.equal(pickOption(p, 'no'), 3);
  assert.deepEqual(answerKeys(p, 'yes', false), ['\r']);
  assert.deepEqual(answerKeys(p, 'no', false), [DOWN, DOWN, DOWN, '\r']);
  assert.deepEqual(answerKeys(p, 'always', true), ['\x1bOB', '\r']);
});

test('Create file prompt (wrapped option, file name as body)', () => {
  const p = parsePrompt(fx('claude-write.txt'))!;
  assert.equal(p.title, 'Create file');
  assert.equal(p.body[0], 'a.txt');
  assert.equal(p.question, 'Do you want to create a.txt?');
  assert.equal(p.options.length, 3);
  assert.match(p.options[1].label, /^Yes, and switch to accept edits .* for this session \(shift\+tab\)$/);
  assert.equal(pickOption(p, 'always'), 1);
  assert.deepEqual(answerKeys(p, 'no', false), [DOWN, DOWN, '\r']);
});

test('folder trust dialog: unnumbered, default is "No, exit"', () => {
  const p = parsePrompt(fx('claude-trust.txt'))!;
  assert.deepEqual(p.options.map((o) => [o.label, o.selected]), [['No, exit', true], ['Yes, I trust this folder', false]]);
  assert.deepEqual(answerKeys(p, 'yes', false), [DOWN, '\r'], 'moves off "No, exit" before Enter');
  assert.deepEqual(answerKeys(p, 'no', false), ['\r']);
  assert.equal(pickOption(p, 'always'), -1);
});

test('selection already moved, plain y/n prompts, and no prompt at all', () => {
  const moved = fx('claude-bash.txt').replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No');
  assert.deepEqual(answerKeys(parsePrompt(moved)!, 'yes', false), [UP, UP, UP, '\r']);
  const yn = parsePrompt('Run migration?\nThis will drop table users\nProceed? (y/n)')!;
  assert.equal(yn.kind, 'yn');
  assert.deepEqual(answerKeys(yn, 'no', false), ['n', '\r']);
  assert.equal(parsePrompt('⏺ Done.\n\n❯ \n'), null, 'an empty input prompt is not a menu');
});

test('waitingForAnswer: live menus and questions block, answered ones in the scrollback do not', async () => {
  const { waitingForAnswer } = await import('../src/agent.ts');
  assert.equal(waitingForAnswer(fx('claude-bash.txt')), true);
  assert.equal(waitingForAnswer(fx('claude-trust.txt')), true);
  assert.equal(waitingForAnswer('Do you want to proceed? (y/n)'), true);
  assert.equal(waitingForAnswer('Do you want to proceed? (y/n) y\napproved\n> '), false);
  assert.equal(waitingForAnswer('⏺ Bash(touch b.txt)\n  ⎿  Done\n\n❯ \n'), false);
});
