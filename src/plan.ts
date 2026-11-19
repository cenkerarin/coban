// Plan mode: the orchestrator proposes a task graph (`coban plan`), the user approves it in the TUI, then the hub
// starts it with the usual spawn / queue. This file is the pure part: validation, conflict warnings, ordering.
import path from 'node:path';
import { NAME_RE } from './config.ts';

export type PlanNode = {
  id: string;
  profile: string;
  task: string;
  after?: string[];               // plan node ids or existing agents; starts once they are done (spawn --after)
  files?: string[];               // files it will write (only used for the conflict warning)
  worktree?: boolean | string;    // true or a branch name (spawn --worktree[=branch])
  verify?: string;
  ctx?: string[];                 // applied by the CLI (snippets into task) before the plan reaches the hub
};
export type Plan = { title: string; nodes: PlanNode[]; cwd?: string };
// The one plan waiting for the user's decision (hub.plan); `from` is who sent it, `seq` binds a decision to it.
export type PendingPlan = Plan & { warnings: string[]; order: string[]; from: string; at: number; seq: number };
export type PlanCheck = { errors: string[]; warnings: string[]; order: string[]; plan?: Plan };
export type PlanEnv = { profiles: string[]; agents?: string[]; reserved?: string[] };

export const MAX_PLAN_NODES = 40;
const CTRL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Kahn's algorithm, stable in plan order. `null` when the in-plan `after` edges have a cycle.
export function topoOrder(nodes: { id: string; after?: string[] }[]): string[] | null {
  const ids = new Set(nodes.map((n) => n.id));
  const done = new Set<string>(), order: string[] = [];
  while (order.length < nodes.length) {
    const next = nodes.find((n) => !done.has(n.id) && (n.after ?? []).every((d) => !ids.has(d) || done.has(d)));
    if (!next) return null;
    done.add(next.id);
    order.push(next.id);
  }
  return order;
}

// Depth of each node: 0 without in-plan dependencies, else 1 + the deepest in-plan dependency. Assumes no cycle.
export function planDepths(nodes: { id: string; after?: string[] }[]): Map<string, number> {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const of = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    depth.set(id, 0); // guards a cycle that slipped through
    const d = Math.max(-1, ...(by.get(id)!.after ?? []).filter((x) => by.has(x)).map(of)) + 1;
    depth.set(id, d);
    return d;
  };
  for (const n of nodes) of(n.id);
  return depth;
}

const normFile = (f: string) => path.posix.normalize(f.trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/') || a === '.' || b === '.';

// Errors make the plan unusable; warnings (two unordered nodes writing the same file in one checkout) are shown to the
// user next to it. `plan` is the cleaned copy (known fields only, ctx dropped) and is set only when there are no errors.
export function validatePlan(raw: unknown, env: PlanEnv): PlanCheck {
  const errors: string[] = [], warnings: string[] = [];
  const fail = (): PlanCheck => ({ errors, warnings, order: [] });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push('plan bir JSON nesnesi olmalı: {title, nodes:[…]}'); return fail(); }
  const p = raw as Record<string, unknown>;
  const title = typeof p.title === 'string' ? p.title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!title) errors.push('title gerekli (boş olmayan metin)');
  else if (title.length > 120) errors.push('title en fazla 120 karakter');
  if (!Array.isArray(p.nodes) || !p.nodes.length) { errors.push('nodes boş olmayan bir dizi olmalı'); return fail(); }
  if (p.nodes.length > MAX_PLAN_NODES) { errors.push(`en fazla ${MAX_PLAN_NODES} düğüm`); return fail(); }
  if (p.cwd !== undefined && typeof p.cwd !== 'string') errors.push('cwd metin olmalı');

  const profiles = new Set(env.profiles), agents = new Set(env.agents ?? []), reserved = new Set(env.reserved ?? []);
  const nodes: PlanNode[] = [];
  const seen = new Set<string>();
  p.nodes.forEach((x: any, i: number) => {
    const at = `düğüm ${i + 1}`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push(`${at}: nesne olmalı`); return; }
    const id = typeof x.id === 'string' ? x.id : '';
    const tag = id ? `${at} (${id})` : at;
    if (!NAME_RE.test(id) || id.includes('..')) errors.push(`${at}: geçersiz id ${JSON.stringify(x.id ?? null)} (harf, rakam, . _ - ; en fazla 48)`);
    else if (reserved.has(id)) errors.push(`${tag}: "${id}" ayrılmış bir ad`);
    else if (seen.has(id)) errors.push(`${tag}: id tekrar ediyor`);
    else if (agents.has(id)) errors.push(`${tag}: "${id}" adlı bir agent zaten var`);
    if (id) seen.add(id);
    if (typeof x.profile !== 'string' || !profiles.has(x.profile)) errors.push(`${tag}: bilinmeyen profil ${JSON.stringify(x.profile ?? null)} (var olanlar: ${env.profiles.join(', ')})`);
    if (typeof x.task !== 'string' || !x.task.trim()) errors.push(`${tag}: task gerekli`);
    if (x.after !== undefined && !isStrs(x.after)) errors.push(`${tag}: after id dizisi olmalı`);
    if (x.files !== undefined && (!isStrs(x.files) || x.files.some((f: string) => !f.trim() || CTRL.test(f)))) errors.push(`${tag}: files dosya yolu dizisi olmalı`);
    if (x.worktree !== undefined && typeof x.worktree !== 'boolean' && !(typeof x.worktree === 'string' && BRANCH_RE.test(x.worktree) && !x.worktree.includes('..'))) errors.push(`${tag}: worktree true/false ya da geçerli bir dal adı olmalı`);
    if (x.verify !== undefined && (typeof x.verify !== 'string' || !x.verify.trim())) errors.push(`${tag}: verify komut metni olmalı`);
    if (x.ctx !== undefined && !isStrs(x.ctx)) errors.push(`${tag}: ctx metin dizisi olmalı`);
    nodes.push({
      id, profile: x.profile, task: x.task,
      ...(isStrs(x.after) && x.after.length ? { after: [...new Set(x.after as string[])] } : {}),
      ...(isStrs(x.files) && x.files.length ? { files: x.files } : {}),
      ...(x.worktree ? { worktree: x.worktree } : {}),
      ...(typeof x.verify === 'string' && x.verify.trim() ? { verify: x.verify } : {}),
    });
  });
  if (errors.length) return fail();

  for (const n of nodes) for (const d of n.after ?? []) {
    if (d === n.id) errors.push(`${n.id}: kendine bağımlı (after)`);
    else if (!seen.has(d) && !agents.has(d)) errors.push(`${n.id}: after "${d}" ne planda ne de mevcut bir agent`);
  }
  if (errors.length) return fail();
  const order = topoOrder(nodes);
  if (!order) {
    // what's left once everything orderable is peeled off is the cycle (plus whatever hangs below it)
    const ok = new Set<string>(), ids = new Set(nodes.map((n) => n.id));
    for (let grew = true; grew;) {
      grew = false;
      for (const n of nodes) if (!ok.has(n.id) && (n.after ?? []).every((d) => !ids.has(d) || ok.has(d))) { ok.add(n.id); grew = true; }
    }
    errors.push(`after döngüsü: ${nodes.filter((n) => !ok.has(n.id)).map((n) => n.id).join(', ')}`);
    return fail();
  }

  // Conflict: two nodes write an overlapping path, neither runs after the other (transitively), both in one checkout.
  const by = new Map(nodes.map((n) => [n.id, n]));
  const anc = new Map<string, Set<string>>();
  const ancestors = (id: string): Set<string> => {
    if (anc.has(id)) return anc.get(id)!;
    const s = new Set<string>();
    anc.set(id, s);
    for (const d of by.get(id)!.after ?? []) if (by.has(d)) { s.add(d); for (const x of ancestors(d)) s.add(x); }
    return s;
  };
  const writers = nodes.filter((n) => n.files?.length && !n.worktree);
  for (let i = 0; i < writers.length; i++) for (let j = i + 1; j < writers.length; j++) {
    const a = writers[i], b = writers[j];
    if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
    const fa = a.files!.map(normFile), fb = b.files!.map(normFile);
    const shared = [...new Set(fa.filter((f) => fb.some((g) => overlaps(f, g))))];
    if (shared.length) warnings.push(`çakışma: ${a.id} ↔ ${b.id} aynı dosyaya yazıyor (${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ', …' : ''}) — after ile sırala ya da birine worktree ver`);
  }
  return { errors, warnings, order, plan: { title, nodes, ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}) } };
}

// One line for `coban plan --show`: "başlık · 3 iş: a(h1) b(h2)←a c(h1)←a,b · 1 uyarı"
export function planSummary(p: Plan, warnings: string[] = []): string {
  const nodes = p.nodes.map((n) => `${n.id}(${n.profile}${n.worktree ? ',wt' : ''})${n.after?.length ? '←' + n.after.join(',') : ''}`);
  return `${p.title} · ${p.nodes.length} iş: ${nodes.join(' ')}${warnings.length ? ` · ${warnings.length} uyarı` : ''}`;
}
