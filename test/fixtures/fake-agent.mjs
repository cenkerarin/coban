#!/usr/bin/env node
// Stand-in for an agent CLI in tests. Raw-mode line input with bracketed paste, a spinner with "esc to interrupt"
// while working. Words in a prompt trigger behaviour:
//   ASK  → a plain "(y/n)" question          POST → messages the orchestrator via `coban post`
//   MENU → a Claude Code style permission menu (❯ selection, arrow keys + Enter), cleared once answered
import { execFileSync } from 'node:child_process';

const out = (s) => process.stdout.write(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out('\x1b[?2004h');

let menu = null; // { options, sel, lines }
let yn = false;
const queue = [];
let busy = false;

function drawMenu(first) {
  const text = [
    '─'.repeat(60),
    ' Bash command',
    ' Remove the build folder',
    '╌'.repeat(60),
    ' rm -rf build',
    '╌'.repeat(60),
    ' Do you want to proceed?',
    ...menu.options.map((o, i) => `${i === menu.sel ? ' ❯' : '  '} ${i + 1}. ${o}`),
    '',
    ' Esc to cancel · Tab to amend',
  ];
  if (!first) out(`\r\x1b[${menu.lines - 1}A\x1b[J`);
  menu.lines = text.length;
  out(text.join('\r\n'));
}

async function work(text) {
  for (let i = 0; i < 3; i++) { out(`\r⠋ working… (esc to interrupt) ${i}`); await sleep(300); }
  out(`\r\x1b[K done: ${JSON.stringify(text.slice(-60))}\r\n`);
  if (text.includes('POST')) execFileSync('coban', ['post', 'orkestra', `${process.env.COBAN_AGENT} bitirdi`]);
  if (text.includes('MENU')) {
    menu = { options: ["Yes", "Yes, and don't ask again for rm commands", 'No'], sel: 0, lines: 0 };
    drawMenu(true);
    return;
  }
  if (text.includes('ASK')) { yn = true; out('Do you want to proceed? (y/n) '); return; }
  out('> ');
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length && !menu && !yn) await work(queue.shift());
  busy = false;
}

let line = '';
function key(k) {
  if (menu) {
    if (k === '\x1b[B' || k === '\x1bOB') menu.sel = Math.min(menu.options.length - 1, menu.sel + 1);
    else if (k === '\x1b[A' || k === '\x1bOA') menu.sel = Math.max(0, menu.sel - 1);
    else if (k === '\r') {
      const chose = menu.options[menu.sel];
      out(`\r\x1b[${menu.lines - 1}A\x1b[J chose: ${chose}\r\n> `);
      menu = null;
      return void pump();
    } else return;
    return drawMenu(false);
  }
  if (k === '\r') {
    const l = line.trim(); line = '';
    out('\r\n');
    if (yn) { yn = false; out(l === 'y' ? 'approved\r\n> ' : 'rejected\r\n> '); return void pump(); }
    if (l) { queue.push(l); pump(); } else out('> ');
  } else if (k === '\x7f') { line = line.slice(0, -1); out('\b \b'); }
  else if (!k.startsWith('\x1b')) { line += k; out(k); }
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  d = d.replace(/\x1b\[20[01]~/g, '');
  for (const k of d.match(/\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Z])|[\s\S]/g) ?? []) key(k);
});

const args = process.argv.slice(2).filter((a, i, all) => !(a === '--model' || all[i - 1] === '--model'));
if (args.length) { queue.push(args.join(' ')); pump(); } else out('> ');
