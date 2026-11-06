// Deterministic context packing: a cheap repo map for the orchestrator and code snippets inlined into worker tasks,
// so workers don't spend requests (each re-reading ~45k of baseline context) searching for code they were pointed at.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|swift|kt|java|rb|php|cs)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.git|\.next|vendor|Pods)\//;
const MAX_SNIPPET_LINES = 150;
const MAX_TOTAL_LINES = 400;

function listFiles(root: string): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.name.startsWith('.') || SKIP.test(rel + '/')) continue;
        if (e.isDirectory()) walk(rel); else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

// Top-level declarations and class members, with 1-based line numbers.
function symbols(src: string, file: string): string[] {
  const out: string[] = [];
  const py = file.endsWith('.py');
  src.split('\n').forEach((l, i) => {
    let m: RegExpMatchArray | null = null;
    if (py) m = l.match(/^(?: {4})?(?:async\s+)?(?:def|class)\s+(\w+)/);
    else {
      m = l.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+(\w+)/) ??
        l.match(/^ {2}(?:(?:public|private|protected|static|async|get|set)\s+)*(\w+)\s*(?:<[^>]*>)?\([^)]*\)?.*\{\s*$/) ??
        l.match(/^(?:func|fn|pub fn|def)\s+(?:\([^)]*\)\s*)?(\w+)/);
    }
    if (m && !/^(if|for|while|switch|return|catch|constructor)$/.test(m[1])) out.push(`${m[1]}:${i + 1}`);
  });
  return out;
}

export function repoMap(root: string, sub = ''): string {
  const files = listFiles(root).filter((f) => (!sub || f.startsWith(sub.replace(/^\.\//, ''))) && !SKIP.test(f));
  const lines: string[] = [];
  let budget = 160;
  for (const f of files) {
    const abs = path.join(root, f);
    let src = '';
    try { if (fs.statSync(abs).size > 400_000) continue; src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const n = src.split('\n').length;
    if (CODE.test(f) && budget > 0) {
      const syms = symbols(src, f);
      lines.push(`${f} (${n})${syms.length ? '  ' + syms.join(' ') : ''}`);
      budget--;
    } else if (!/\.(lock|png|jpe?g|gif|ico|svg|woff2?)$|package-lock\.json$/.test(f)) {
      lines.push(`${f} (${n})`);
    }
  }
  return lines.join('\n');
}

// End line (0-based, inclusive) of the block starting at `start`.
function blockEnd(ls: string[], start: number, py: boolean): number {
  if (py) {
    const ind = ls[start].match(/^\s*/)![0].length;
    let end = start;
    for (let i = start + 1; i < ls.length; i++) {
      if (!ls[i].trim()) continue;
      if (ls[i].match(/^\s*/)![0].length <= ind) break;
      end = i;
    }
    return end;
  }
  let depth = 0, seen = false;
  for (let i = start; i < ls.length; i++) {
    for (const ch of ls[i].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""')) {
      if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) return i;
    if (!seen && /;\s*$/.test(ls[i])) return i; // one-line declaration
  }
  return ls.length - 1;
}

function findSymbol(ls: string[], name: string, py: boolean): number {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = py
    ? [new RegExp(`^\\s*(async\\s+)?(def|class)\\s+${n}\\b`)]
    : [
        new RegExp(`^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function\\*?|class|interface|type|enum|const|let|var)\\s+${n}\\b`),
        new RegExp(`^\\s*((public|private|protected|static|async|get|set)\\s+)*${n}\\s*(<[^>]*>)?\\(`),
        new RegExp(`^\\s*(func|fn|pub fn)\\s+(\\([^)]*\\)\\s*)?${n}\\b`),
      ];
  for (const re of pats) { const i = ls.findIndex((l) => re.test(l)); if (i >= 0) return i; }
  return -1;
}

const numbered = (ls: string[], a: number, b: number) =>
  ls.slice(a, b + 1).map((l, k) => `${String(a + k + 1).padStart(4)}│ ${l}`).join('\n');

// spec: "path:10-80" | "path:42" | "path#sym1,sym2" | "path" (whole file, capped)
export function snippets(specs: string[], cwd: string): string {
  const parts: string[] = [];
  let total = 0;
  for (const spec of specs.flatMap((s) => s.split(';')).map((s) => s.trim()).filter(Boolean)) {
    const m = spec.match(/^(.*?)(?:#(.+)|:(\d+)(?:-(\d+))?)?$/)!;
    const file = m[1];
    let ls: string[];
    try { ls = fs.readFileSync(path.resolve(cwd, file), 'utf8').split('\n'); }
    catch { parts.push(`### ${spec}\n(dosya okunamadı)`); continue; }
    const py = file.endsWith('.py');
    const ranges: [number, number, string][] = []; // a < 0 marks a missing symbol, kept in order
    if (m[2]) {
      for (const sym of m[2].split(',').map((s) => s.trim()).filter(Boolean)) {
        const s = findSymbol(ls, sym, py);
        if (s < 0) { ranges.push([-1, -1, `#${sym}`]); continue; }
        ranges.push([s, Math.min(blockEnd(ls, s, py), s + MAX_SNIPPET_LINES - 1), `#${sym}`]);
      }
    } else if (m[3]) {
      const a = Math.max(1, Number(m[3])), b = m[4] ? Number(m[4]) : a + 20;
      ranges.push([a - 1, Math.min(ls.length - 1, b - 1, a - 1 + MAX_SNIPPET_LINES - 1), `:${a}-${b}`]);
    } else ranges.push([0, Math.min(ls.length - 1, MAX_SNIPPET_LINES - 1), '']);
    for (const [a, b, tag] of ranges) {
      if (a < 0) { parts.push(`### ${file}${tag}\n(sembol bulunamadı)`); continue; }
      if (total >= MAX_TOTAL_LINES) { parts.push(`### ${file}${tag}\n(atlandı: bağlam sınırı ${MAX_TOTAL_LINES} satır)`); continue; }
      const end = Math.min(b, a + (MAX_TOTAL_LINES - total) - 1);
      total += end - a + 1;
      const cut = end < blockEnd(ls, a, py) && tag.startsWith('#') ? `\n     … (kısaltıldı, devamı ${end + 2}. satırdan)` : '';
      parts.push(`### ${file}${tag}  (satır ${a + 1}-${end + 1})\n${numbered(ls, a, end)}${cut}`);
    }
  }
  return parts.length ? `\n\nİLGİLİ KOD (coban'ın görevi verdiği an itibarıyla güncel; bu kısımları yeniden okuma/arama):\n${parts.join('\n\n')}` : '';
}
