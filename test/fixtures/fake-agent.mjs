#!/usr/bin/env node
// Stand-in for an agent CLI in tests: bracketed paste on, a spinner with "esc to interrupt" while working,
// "ASK" in a prompt shows a permission question, "POST" in a prompt makes it message the orchestrator.
import { execFileSync } from 'node:child_process';
import readline from 'node:readline';

process.stdout.write('\x1b[?2004h');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function work(text) {
  for (let i = 0; i < 3; i++) { process.stdout.write(`\r⠋ working… (esc to interrupt) ${i}`); await sleep(300); }
  process.stdout.write(`\r\x1b[K done: ${JSON.stringify(text.slice(-60))}\r\n`);
  if (text.includes('ASK')) process.stdout.write('Do you want to proceed? (y/n)\r\n');
  if (text.includes('POST')) execFileSync('coban', ['post', 'orkestra', `${process.env.COBAN_AGENT} bitirdi`]);
}
const args = process.argv.slice(2).filter((a, i, all) => !(a === '--model' || all[i - 1] === '--model'));
if (args.length) await work(args.join(' '));
process.stdout.write('> ');
const rl = readline.createInterface({ input: process.stdin });
for await (const raw of rl) {
  const line = raw.replace(/\x1b\[20[01]~/g, '').trim();
  if (line === 'y') process.stdout.write('approved\r\n');
  else if (line) await work(line);
  process.stdout.write('> ');
}
