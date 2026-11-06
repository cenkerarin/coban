// Reads an agent's permission question off its screen and works out the keys that answer it.
// Built against real Claude Code screens (test/fixtures/prompts). Claude Code's dialog looks like:
//
//   ─────────────────────────     top separator
//    Bash command                 title
//    Create empty b.txt file      description
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    touch b.txt                  body (command / diff)
//   ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
//    Do you want to proceed?      question
//    ❯ 1. Yes                     options; ❯ marks the selected one, long labels wrap
//      2. Yes, and always allow access to …
//      3. No
//
// Options are chosen by moving the selection with arrow keys and pressing Enter, never by digit: some menus (the
// folder-trust dialog) have no numbers, and there the default selection is "No, exit".

export type PromptOption = { label: string; selected: boolean };
export type Prompt = {
  title: string;        // e.g. "Bash command", "Create file"
  body: string[];       // the command, file name or diff lines (a few)
  question: string;     // e.g. "Do you want to proceed?"
  options: PromptOption[];
  kind: 'menu' | 'yn';  // arrow-key menu, or a plain (y/n) question
  key: string;          // identity, so an answer meant for one prompt never lands on the next
};
export type Choice = 'yes' | 'always' | 'no';

const MARK = /^\s*[❯›▶]\s*/;
const NUM = /^\s*(?:[❯›▶]\s*)?\d[.)]\s+/;
const SOLID = /^[\s─━═]{10,}$/;
const DASHED = /^[\s╌┄┈╍]{10,}$/;
const FOOTER = /^\s*(Esc to|Enter to|Tab to|ctrl\+|↑↓)/i;
const YN = /\((y\/n)\)|\[y\/N\]|\[Y\/n\]/;

export function parsePrompt(screen: string): Prompt | null {
  const L = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  const tail = Math.max(0, L.length - 20);
  let mi = -1;
  for (let i = L.length - 1; i >= tail; i--) if (MARK.test(L[i]) && !/^\s*❯\s*$/.test(L[i])) { mi = i; break; }
  if (mi < 0) return parseYN(L);

  // the option block around the selected line
  const numbered = NUM.test(L[mi]);
  const isOpt = (l: string) => !!l.trim() && !FOOTER.test(l) && !SOLID.test(l) && !DASHED.test(l);
  const isNum = (l: string) => NUM.test(l);
  let a = mi, b = mi;
  if (numbered) {
    // upwards: numbered lines and their wrapped continuations, stopping at the question
    for (let i = mi - 1; i >= 0 && isOpt(L[i]); i--) {
      if (isNum(L[i])) a = i;
      else if (!/^\s{4,}\S/.test(L[i])) break;
    }
    while (b + 1 < L.length && isOpt(L[b + 1]) && (isNum(L[b + 1]) || /^\s{4,}\S/.test(L[b + 1]))) b++;
  } else {
    while (a > 0 && isOpt(L[a - 1])) a--;
    while (b + 1 < L.length && isOpt(L[b + 1])) b++;
  }
  const options: PromptOption[] = [];
  for (const l of L.slice(a, b + 1)) {
    const selected = MARK.test(l);
    const text = l.replace(MARK, '').replace(/^\s*\d[.)]\s+/, '').trim();
    if (numbered && !isNum(l) && options.length) options[options.length - 1].label += ' ' + text;
    else options.push({ label: text, selected });
  }

  // question: nearest non-empty line above; context: up to the solid separator
  let qi = a - 1;
  while (qi >= 0 && !L[qi].trim()) qi--;
  const question = (L[qi] ?? '').trim();
  const ctx: string[] = [];
  for (let i = qi - 1; i >= 0 && ctx.length < 14; i--) {
    if (SOLID.test(L[i])) break;
    if (DASHED.test(L[i]) || !L[i].trim()) continue;
    ctx.unshift(L[i].trim());
  }
  const lines = ctx.filter((l) => !/^Tip:/i.test(l));
  const title = lines[0] ?? question;
  const body = lines.slice(1, 5);
  return { title, body, question, options, kind: 'menu', key: `${title}|${question}|${options.map((o) => o.label).join('|')}` };
}

function parseYN(L: string[]): Prompt | null {
  // only the question being answered right now: among the last two non-empty lines
  const recent = L.map((l, i) => [l, i] as const).filter(([l]) => l.trim()).slice(-2).map(([, i]) => i);
  for (const i of recent.reverse()) {
    if (!YN.test(L[i])) continue;
    const question = L[i].trim();
    const ctx = L.slice(Math.max(0, i - 4), i).map((l) => l.trim()).filter(Boolean);
    return { title: ctx[0] ?? question, body: ctx.slice(1), question, options: [], kind: 'yn', key: `yn|${question}` };
  }
  return null;
}

// Which option a choice picks. "always" is only offered when the menu has a "Yes, and …" option that isn't a
// mode switch; the UI shows its exact label so the user knows what it grants.
export function pickOption(p: Prompt, choice: Choice): number {
  const o = p.options.map((x) => x.label);
  if (choice === 'yes') {
    const plain = o.findIndex((l) => /^(yes|evet)\b/i.test(l) && !/^yes,? and\b/i.test(l));
    return plain >= 0 ? plain : o.findIndex((l) => /^(yes|evet)\b/i.test(l));
  }
  if (choice === 'always') return o.findIndex((l) => /^yes,? and\b/i.test(l) && !/auto mode|bypass/i.test(l));
  const no = o.findIndex((l) => /^(no|hayır)\b/i.test(l));
  return no >= 0 ? no : o.length - 1;
}

// Keys that make the choice: arrows from the current selection, then Enter. `appCursor` follows the terminal's
// application-cursor mode (DECCKM), which changes what the arrow keys send.
export function answerKeys(p: Prompt, choice: Choice, appCursor: boolean): string[] | null {
  if (p.kind === 'yn') return [choice === 'no' ? 'n' : 'y', '\r'];
  const target = pickOption(p, choice);
  if (target < 0) return null;
  const from = Math.max(0, p.options.findIndex((o) => o.selected));
  const arrow = (appCursor ? '\x1bO' : '\x1b[') + (target > from ? 'B' : 'A');
  return [...Array(Math.abs(target - from)).fill(arrow), '\r'];
}
