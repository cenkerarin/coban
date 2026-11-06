import fs from 'node:fs';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Agent, keyBytes, type Msg, type Role, type Status } from './agent.ts';
import { BIN_DIR, SOCK, STATE_DIR, type Config, type Profile } from './config.ts';

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const SETTLED: Status[] = ['idle', 'blocked', 'limited', 'exited'];

const ORCH_PROMPT = (id: string, profiles: Profile[]) => `Sen "coban" adlı terminal uygulamasının ORKESTRATÖRÜsün (kimliğin: ${id}). Kullanıcı seninle bu panelde konuşuyor; diğer panellerde senin açtığın işçi agent'lar çalışıyor. İşin: isteği bağımsız parçalara bölmek, işçilere dağıtmak, izlemek, sonuçları birleştirip kullanıcıya raporlamak. Kod yazma işini işçilere bırak.

İşçileri Bash'te \`coban\` ile yönetirsin (izin sormadan çalışır, çıktılar kısa ve tek satırlıktır):
  coban agents                         agent'lar: id, profil, model, durum (working/blocked/limited/idle/exited)
  coban spawn <profil> "<görev>" [--name ad] [--cwd dizin]
  coban send <id> "<mesaj>"            meşgulse boşalınca iletilir
  coban wait [id...] [--timeout 600]   bir işçi durunca veya sana mesaj gelince döner
  coban read <id> [--lines 20]         işçinin ekranının son satırları (arayüz süsleri ayıklanmış)
  coban key <id> <tuş...>              enter, esc, up, down, tab, 1, 2, y ...
  coban kill <id>  ·  coban inbox  ·  coban post user "<mesaj>"

Profiller: ${profiles.map((p) => `${p.id} (${p.title}${p.model ? ', ' + p.model : ''})`).join(', ')}.

CONTEXT'İ KORU — her çağrının çıktısı bağlamına eklenir ve sonraki her istekte yeniden okunur:
- Sonucu işçinin göndereceği özetten öğren. \`coban read\`'i yalnızca işçi "blocked" iken veya özet anlamsızsa kullan; --lines'ı küçük tut.
- İşçiler uzun sonuçları .coban/reports/<id>.md dosyasına yazar ve sana yolunu gönderir. O dosyayı ancak gerçekten gerekiyorsa, gerekirse yalnızca ilgili kısmını oku.
- Beklerken uzun timeout kullan (\`coban wait --timeout 600\`), arka arkaya \`coban agents\` çağırma.
- Görevleri kısa ve kendi içinde yeterli yaz: işçiye neyi, nerede, hangi kısıtla yapacağını söyle; dosyaları senin yerine o okusun.
- İşi biten işçiyi \`coban kill\` ile kapat. Alakasız yeni bir iş için eski işçiyi kullanma, yeni işçi aç.

Kurallar:
- Aynı dosyalara yazacak iki işçi açma; gerekiyorsa ayrı git worktree kullandır.
- Ağır kod işini Opus profillerine, okuma/inceleme/küçük işleri Sonnet profillerine ver; hesapları dengeli kullan. "limited" olan işçinin işini başka hesaba devret.
- "blocked" işçinin izin sorusunu güvenli ve görev kapsamındaysa \`coban key\` ile onayla, emin değilsen kullanıcıya sor.
- Bitince sonucu doğrula ve kullanıcıya kısa özet ver.`;

const WORKER_PREAMBLE = (id: string, orch: string) => `[coban] Sen coban içinde çalışan bir işçi agent'sın. Kimliğin: ${id}. Orkestratör: ${orch}.
Diğer agent'larla kabukta konuşursun: \`coban post <id> "mesaj"\` (liste: \`coban agents\`, gelen kutun: \`coban inbox\`).
Bitince orkestratöre EN FAZLA 5 satırlık özet gönder: \`coban post ${orch} "..."\`. Ayrıntı (uzun rapor, liste, diff açıklaması) gerekiyorsa .coban/reports/${id}.md dosyasına yaz ve özette sadece yolunu ver. Belirsizlik olursa orkestratöre kısa bir soru gönder.

GÖREV:
`;

// Lines that are Claude Code / Codex chrome rather than content.
const CHROME = /^\s*([─━═╌┄\-]{8,}|❯\s*$|>\s*$|[⏵►▶]{2}|\? for shortcuts|Tip:|auto mode|accept edits|bypass permissions|plan mode|Context left|\/model to|↵ send)/;

// Workers write long reports to <cwd>/.coban/reports; the folder ignores itself so it never gets committed.
function ensureReportsDir(cwd: string) {
  try {
    fs.mkdirSync(`${cwd}/.coban/reports`, { recursive: true });
    if (!fs.existsSync(`${cwd}/.coban/.gitignore`)) fs.writeFileSync(`${cwd}/.coban/.gitignore`, '*\n');
  } catch {}
}

export function compactScreen(text: string, lines: number): string {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    if (CHROME.test(l)) continue;
    if (!l.trim() && (!out.length || !out[out.length - 1].trim())) continue; // collapse blank runs
    out.push(l.replace(/\s+$/, ''));
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-lines).join('\n');
}

export class Hub extends EventEmitter {
  cfg: Config;
  agents = new Map<string, Agent>();
  order: string[] = [];
  focus = '';
  log: Msg[] = [];
  seen = new Map<string, Map<string, number>>(); // caller → agent → settledSeq already reported
  size = { cols: 100, rows: 30 };
  private msgSeq = 0;
  private server?: net.Server;

  constructor(cfg: Config) {
    super();
    this.cfg = cfg;
    setInterval(() => { for (const a of this.agents.values()) a.tick(); }, 400).unref();
  }

  profile(id: string): Profile {
    const p = this.cfg.profiles.find((x) => x.id === id);
    if (!p) throw new Error(`bilinmeyen profil: ${id} (var olanlar: ${this.cfg.profiles.map((x) => x.id).join(', ')})`);
    return p;
  }

  get orchestratorId() { return this.order.find((id) => this.agents.get(id)?.role === 'orchestrator') ?? ''; }

  private newId(base: string) {
    if (!this.agents.has(base) && base !== 'user') return base;
    for (let n = 2; ; n++) if (!this.agents.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  spawn(o: { profile: string; role: Role; task?: string; name?: string; cwd?: string }): Agent {
    const p = this.profile(o.profile);
    const id = this.newId(o.name || (o.role === 'orchestrator' ? 'orkestra' : p.id));
    const parts = [p.cmd];
    const model = (o.role === 'orchestrator' && this.cfg.orchestratorModel) || p.model;
    if (model) parts.push(`--model ${q(model)}`);
    if (o.role === 'orchestrator' && p.cmd.startsWith('claude')) parts.push(`--append-system-prompt ${q(ORCH_PROMPT(id, this.cfg.profiles))}`);
    let task = o.task?.trim() ?? '';
    if (task && o.role === 'worker') task = WORKER_PREAMBLE(id, this.orchestratorId || 'user') + task;
    if (task) parts.push((p.promptArg ?? '{prompt}').replace('{prompt}', q(task)));

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(p.env ?? {}),
      COBAN_AGENT: id,
      COBAN_SOCK: SOCK,
      PATH: `${BIN_DIR}:${process.env.PATH}`,
      TERM: 'xterm-256color',
    };
    delete env.CLAUDECODE; // don't let a parent Claude session leak into children

    const cwd = o.cwd || process.cwd();
    if (o.role === 'worker') ensureReportsDir(cwd);
    const a = new Agent({ id, profile: p, role: o.role, task: o.task ?? '', cwd, cmd: parts.join(' '), env, ...this.size });
    a.model = model ?? '';
    a.on('render', () => this.emit('render', a));
    a.on('status', (s: Status) => {
      if (SETTLED.includes(s)) {
        if (this.focus !== a.id) a.unread = true;
        if (s === 'idle') this.flushInbox(a);
      }
      this.emit('change');
    });
    this.agents.set(id, a);
    this.order.push(id);
    if (!this.focus) this.focus = id;
    this.emit('change');
    return a;
  }

  kill(id: string) {
    const a = this.get(id);
    a.kill();
    this.agents.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.focus === id) this.focus = this.order[0] ?? '';
    this.emit('change');
  }

  get(id: string): Agent {
    const a = this.agents.get(id);
    if (!a) throw new Error(`agent yok: ${id}`);
    return a;
  }

  setFocus(id: string) {
    if (!this.agents.has(id)) return;
    this.focus = id;
    this.agents.get(id)!.unread = false;
    this.emit('change');
  }

  resizeAll(cols: number, rows: number) {
    this.size = { cols, rows };
    for (const a of this.agents.values()) a.resize(cols, rows);
  }

  // ── messaging ────────────────────────────────────────────────
  post(from: string, to: string, text: string): Msg {
    const m: Msg = { id: ++this.msgSeq, from, to, text, ts: Date.now(), delivered: false };
    this.log.push(m);
    if (this.log.length > 500) this.log.shift();
    if (to === 'user') { m.delivered = true; this.emit('notify', m); }
    else {
      const a = this.get(to);
      a.inbox.push(m);
      if (a.status === 'idle') this.flushInbox(a);
    }
    this.emit('change');
    return m;
  }

  private flushInbox(a: Agent) {
    const pending = a.inbox.filter((m) => !m.delivered);
    if (!pending.length || a.exitCode !== null) return;
    for (const m of pending) m.delivered = true;
    a.deliver(pending.map((m) => `[coban mesajı · ${m.from} → ${m.to}] ${m.text}`).join('\n\n'));
  }

  takeInbox(id: string): Msg[] {
    if (id === 'user') return [];
    const a = this.get(id);
    const pending = a.inbox.filter((m) => !m.delivered);
    for (const m of pending) m.delivered = true;
    return pending;
  }

  // Resolve once any watched agent settles (and the caller hasn't seen that yet) or the caller gets mail.
  wait(caller: string, ids: string[], timeoutS: number): Promise<object> {
    const seen = this.seen.get(caller) ?? new Map<string, number>();
    this.seen.set(caller, seen);
    const watched = () => (ids.length ? ids : this.order.filter((x) => x !== caller));
    const check = () => {
      const settled = watched()
        .map((id) => this.agents.get(id))
        .filter((a): a is Agent => !!a && SETTLED.includes(a.status) && a.settledSeq > (seen.get(a.id) ?? 0));
      const gone = ids.filter((id) => !this.agents.has(id));
      const mail = caller !== 'user' && this.agents.has(caller) ? this.agents.get(caller)!.inbox.some((m) => !m.delivered) : false;
      if (!settled.length && !mail && !gone.length) return null;
      for (const a of settled) seen.set(a.id, a.settledSeq);
      return {
        settled: settled.map((a) => ({ id: a.id, status: a.status })),
        removed: gone,
        messages: mail ? this.takeInbox(caller).map(({ from, text }) => ({ from, text })) : [],
      };
    };
    return new Promise((resolve) => {
      const now = check();
      if (now) return resolve(now);
      const onChange = () => { const r = check(); if (r) { done(); resolve(r); } };
      const timer = setTimeout(() => { done(); resolve({ timeout: true, agents: this.list() }); }, timeoutS * 1000);
      const done = () => { clearTimeout(timer); this.off('change', onChange); };
      this.on('change', onChange);
    });
  }

  list() {
    return this.order.map((id) => {
      const a = this.agents.get(id)!;
      return {
        id, profile: a.profile.id, model: a.model, role: a.role, status: a.status,
        ...(a.cwd !== process.cwd() ? { cwd: a.cwd } : {}),
        task: a.task.replace(/\s+/g, ' ').slice(0, 60),
        unreadMessages: a.inbox.filter((m) => !m.delivered).length,
      };
    });
  }

  // ── RPC over unix socket (used by the `coban` CLI inside agents) ─────
  async handle(caller: string, method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'agents': return { agents: this.list(), profiles: this.cfg.profiles.map(({ id, title, model }) => ({ id, title, model })) };
      case 'spawn': {
        const a = this.spawn({ profile: p.profile, role: 'worker', task: p.task, name: p.name, cwd: p.cwd });
        return { id: a.id };
      }
      case 'send':
      case 'post': return { ok: true, id: this.post(caller, p.to, p.text).id };
      case 'read': {
        const a = this.get(p.id);
        const n = p.lines ?? 20;
        const screen = p.raw ? a.screenText(n, !!p.scrollback) : compactScreen(a.screenText(n * 3, !!p.scrollback), n);
        return { id: a.id, status: a.status, screen };
      }
      case 'key': {
        const a = this.get(p.id);
        for (const k of p.keys as string[]) { a.proc.write(keyBytes(a, k)); await new Promise((r) => setTimeout(r, 120)); }
        return { ok: true };
      }
      case 'wait': return this.wait(caller, p.ids ?? [], p.timeout ?? 300);
      case 'inbox': return { messages: this.takeInbox(caller).map(({ from, text, ts }) => ({ from, text, ts })) };
      case 'kill': this.kill(p.id); return { ok: true };
      case 'log': return { messages: this.log.slice(-(p.limit ?? 30)) };
      default: throw new Error(`bilinmeyen komut: ${method}`);
    }
  }

  listen() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    try { fs.unlinkSync(SOCK); } catch {}
    this.server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', async (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let req: any;
          try { req = JSON.parse(line); } catch { continue; }
          try { sock.write(JSON.stringify({ ok: true, result: await this.handle(req.caller || 'user', req.method, req.params ?? {}) }) + '\n'); }
          catch (e: any) { sock.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); }
        }
      });
      sock.on('error', () => {});
    });
    this.server.listen(SOCK);
  }

  shutdown() {
    for (const a of this.agents.values()) a.kill();
    this.server?.close();
    try { fs.unlinkSync(SOCK); } catch {}
  }
}
