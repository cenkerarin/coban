import net from 'node:net';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { appendProfile, CONFIG_PATH, loadConfig, nextAccount, ruleRegex, saveRules, SOCK, type ApprovalRule } from './config.ts';
import { repoMap, snippets } from './context.ts';
import { allUsage, fmtEta, fmtTokens, type AccountUsage } from './usage.ts';
import { readHistory } from './history.ts';

const HELP = `coban — çok hesaplı agent orkestratörü

  coban [--cwd dizin]                 arayüzü aç (orkestratörü graf alanındaki + ile seç)

Agent'ların içinden (veya başka bir terminalden):
  coban agents                        agent listesi ve durumları
  coban spawn <profil> "<görev>" [--name ad] [--cwd dizin] [--ctx yer]...
                                      --ctx: "dosya:10-80" | "dosya#sembol1,sembol2" | "dosya"
                                      ilgili kodu satır numaralı olarak görevin içine ekler (send/post'ta da var)
        [--after id1,id2]             kuyruğa al: bu agent'lar bitince (idle/exited, doğrulaması geçmiş) başlar
        [--worktree[=dal]]            ayrı git worktree'si (<repo>-<id>, dal coban/<id>) açıp işçiyi orada başlatır
        [--verify "<komut>"]          işçi durunca komutu cwd'sinde koşar; başarısızsa çıktının sonunu ona geri gönderir
  coban map [alt-dizin]               repo haritası: dosyalar, satır sayıları, semboller:satır
  coban send <id> "<mesaj>"           (post ile aynı)
  coban post <id|user|all> "<mesaj>"  all = ortak kutu (herkes görür)
  coban wait [id...] [--timeout sn]   biri durunca / mesaj gelince döner
  coban read <id> [--lines n] [--scrollback] [--raw]
  coban approvals                     izin bekleyen agent'lar ve soruları
  coban approve <id> [yes|always|no]  izni yanıtla (varsayılan yes)
  coban rule add "<regex>" [--cwd dizin] [--profile id]
                                      kalıcı onay kuralı: izin metni regex ile TAM eşleşirse otomatik "yes"
                                      (metin: coban approvals'taki gövde satırları " · " ile birleşik; varsayılan kural yok)
  coban rule list | coban rule rm <no>
  coban key <id> <tuş...>             enter esc up down tab 1 2 y ...
  coban kill <id> [--rm-worktree]     --rm-worktree: işçinin worktree'sini de sil (değişiklik varsa silmez; dal kalır)
  coban inbox                         özel mesajlar + ortak kutudaki yeniler
  coban board [--limit n]             ortak kutunun son notları
  coban usage                         hesap kullanımı (5s %, 7g token, reset), en az harcayan başta
  coban log [--limit n]
  coban history [--limit n]           kalıcı oturum geçmişi (olaylar + mesajlar, ~/.coban/history.jsonl)
  coban account add                   yeni Claude hesabı ekle: giriş yaptırır, profili config'e yazar (arayüz kapalıyken)

Her komut --json ile ham çıktı verir.`;

function call(method: string, params: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify({ caller: process.env.COBAN_AGENT || 'user', method, params }) + '\n'));
    s.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const res = JSON.parse(buf.slice(0, i));
      s.end();
      res.ok ? resolve(res.result) : reject(new Error(res.error));
    });
    s.on('error', (e: any) => reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('coban çalışmıyor (önce `coban` ile arayüzü aç)') : e));
  });
}

const BOOL_FLAGS = ['scrollback', 'raw', 'json', 'worktree', 'rm-worktree'];

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  const ctx: string[] = []; // --ctx may repeat
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (k === 'ctx') { const val = v ?? argv[++i]; if (val) ctx.push(val); continue; }
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !BOOL_FLAGS.includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags, ctx };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags, ctx } = parse(rest);
  const num = (v: unknown) => (v === undefined || v === true ? undefined : Number(v));

  if (cmd === 'account') {
    if (pos[0] !== 'add') { console.log('kullanım: coban account add'); process.exit(1); }
    const cfg = loadConfig();
    const { profile, dir } = nextAccount(cfg);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Yeni hesap: ${profile.id} (${dir})\nClaude açılıyor: tarayıcıdan giriş yap, sonra /exit yaz.\n`);
    const r = spawnSync('claude', [], { stdio: 'inherit', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    if (r.error) { console.error('claude bulunamadı: önce Claude Code kur (https://claude.com/claude-code)'); process.exit(1); }
    if (!fs.readdirSync(dir).length) { console.error('Giriş yapılmamış görünüyor, profil eklenmedi. Tekrar dene: coban account add'); process.exit(1); }
    appendProfile(profile);
    console.log(`\n${profile.id} eklendi (${CONFIG_PATH}). Arayüzü yeniden aç: coban`);
    return;
  }

  if (!cmd || cmd === '--cwd') {
    if (cmd === '--cwd') process.chdir(rest[0]);
    const { Hub } = await import('./hub.ts');
    const { Tui } = await import('./tui.ts');
    try { await call('agents', {}); console.error('coban zaten açık (soket: ' + SOCK + ')'); process.exit(1); } catch {}
    const hub = new Hub(loadConfig());
    const tui = new Tui(hub);
    hub.size = tui.paneSize;
    hub.listen();
    tui.start();
    const quit = () => { tui.stop(); hub.shutdown(); process.exit(0); };
    process.on('SIGTERM', quit);
    process.on('SIGHUP', quit);
    process.on('uncaughtException', (e) => { tui.stop(); hub.shutdown(); console.error(e); process.exit(1); });
    return;
  }

  // Output is plain one-liners on purpose: it lands in the calling agent's context. --json gives the raw result.
  const json = !!flags.json;
  const print = (r: unknown, text: () => string) => console.log(json ? JSON.stringify(r) : text());
  const short = (m?: string) => (m ? m.replace(/^claude-/, '') : '');
  const one = (s: string) => s.replace(/\s+/g, ' ').trim();
  const usageTag = (u: any) => `tok=${fmtTokens(u.tokens)}` + (u.remainPct === undefined ? '' : ` kalan=%${Math.round(u.remainPct * 100)}${u.etaMs === null ? '' : ' ' + fmtEta(u.etaMs)}`);
  const agentLine = (a: any) =>
    [a.id, `${a.profile}${a.model ? '/' + short(a.model) : ''}`, a.role === 'orchestrator' ? '★' : a.role === 'manual' ? 'manuel' : '', a.status,
      a.unreadMessages ? `✉${a.unreadMessages}` : '', a.usage ? usageTag(a.usage) : '', a.verify ? `doğrulama:${a.verify}` : '', a.boardUnread ? `▤${a.boardUnread}` : '', a.cwd ? `cwd=${a.cwd}` : '', a.task ? `"${a.task}"` : '']
      .filter(Boolean).join('  ');

  switch (cmd) {
    case 'agents': {
      const r = await call('agents', {});
      const queuedLine = (j: any) => [j.id, j.profile, `kuyrukta (bekliyor: ${j.after.join(', ')})`, j.task ? `"${j.task}"` : ''].filter(Boolean).join('  ');
      return print(r, () => [...r.agents.map(agentLine), ...(r.queued ?? []).map(queuedLine), 'profiller: ' + r.profiles.map((p: any) => `${p.id}${p.model ? '/' + short(p.model) : ''}`).join(' ')].join('\n'));
    }
    case 'spawn': {
      const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const after = str(flags.after)?.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await call('spawn', {
        profile: pos[0], task: pos.slice(1).join(' ') + snippets(ctx, cwd), name: flags.name, cwd: flags.cwd,
        after, worktree: flags.worktree, verify: str(flags.verify),
      });
      return print(r, () => r.queued ? `kuyrukta: ${r.id} (bekliyor: ${after!.join(', ')})` : `açıldı: ${r.id}${r.worktree ? `  worktree=${r.worktree} dal=${r.branch}` : ''}`);
    }
    case 'send': case 'post': {
      const r = await call('post', { to: pos[0], text: pos.slice(1).join(' ') + snippets(ctx, process.cwd()) });
      return print(r, () => `gönderildi → ${pos[0]}`);
    }
    case 'wait': {
      const r = await call('wait', { ids: pos, timeout: num(flags.timeout) });
      return print(r, () => {
        if (r.timeout) return 'zaman aşımı · ' + r.agents.map((a: any) => `${a.id}:${a.status}`).join(' ');
        const out: string[] = [];
        if (r.settled.length) out.push('durdu: ' + r.settled.map((a: any) => `${a.id} ${a.status}`).join(', '));
        if (r.removed.length) out.push('artık yok: ' + r.removed.join(', '));
        for (const m of r.messages) out.push(`✉ ${m.from}: ${m.text}`);
        for (const m of r.board ?? []) out.push(`[ortak] ${m.from}: ${m.text}`);
        return out.join('\n');
      });
    }
    case 'read': {
      const r = await call('read', { id: pos[0], lines: num(flags.lines), scrollback: !!flags.scrollback, raw: !!flags.raw });
      return print(r, () => `[${r.id} · ${r.status}]\n${r.screen}`);
    }
    case 'key': { const r = await call('key', { id: pos[0], keys: pos.slice(1) }); return print(r, () => 'tamam'); }
    case 'approvals': {
      const r = await call('approvals', {});
      return print(r, () => r.approvals.length ? r.approvals.map((x: any) => {
        const p = x.prompt;
        if (!p) return `${x.id}  ${x.profile}  soru okunamadı — coban read ${x.id}`;
        const opts = p.options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join('  ');
        return [`${x.id}  ${x.profile}  ${p.title}${p.body.length ? ': ' + p.body.join(' · ') : ''}`, `  ? ${p.question}${opts ? '  ' + opts : ''}`].join('\n');
      }).join('\n') : '(izin bekleyen yok)');
    }
    case 'approve': {
      const r = await call('approve', { id: pos[0], choice: pos[1] ?? 'yes' });
      return print(r, () => `${pos[0]}: "${r.picked}" seçildi`);
    }
    case 'rule': {
      const sub = pos[0];
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      // Edit through the running coban (it keeps the rules in memory); with it closed, edit the config file.
      const viaHub = async (method: string, params: object, offline: () => any) => {
        try { return await call(method, params); }
        catch (e: any) { if (!/çalışmıyor/.test(e.message)) throw e; return offline(); }
      };
      if (sub === 'add') {
        if (!pos[1]) { console.error('kullanım: coban rule add "<regex>" [--cwd dizin] [--profile id]'); process.exit(1); }
        const rule: ApprovalRule = { match: pos[1], ...(str(flags.cwd) ? { cwd: str(flags.cwd) } : {}), ...(str(flags.profile) ? { profile: str(flags.profile) } : {}) };
        ruleRegex(rule.match);
        const r = await viaHub('rule_add', rule, () => {
          const rules = [...(loadConfig().rules ?? []), rule];
          saveRules(rules);
          return { n: rules.length };
        });
        return print(r, () => `kural #${r.n} eklendi`);
      }
      if (sub === 'rm') {
        const r = await viaHub('rule_rm', { n: pos[1] }, () => {
          const rules = loadConfig().rules ?? [];
          const i = Number(pos[1]) - 1;
          if (!Number.isInteger(i) || i < 0 || i >= rules.length) throw new Error(`böyle bir kural yok: ${pos[1]}`);
          const [removed] = rules.splice(i, 1);
          saveRules(rules);
          return { removed };
        });
        return print(r, () => `kural silindi: ${r.removed.match}`);
      }
      if (sub === 'list' || sub === undefined) {
        const r = await viaHub('rules', {}, () => ({ rules: loadConfig().rules ?? [] }));
        return print(r, () => r.rules.length
          ? r.rules.map((x: ApprovalRule, i: number) => `${i + 1}  /${x.match}/${x.cwd ? `  cwd=${x.cwd}` : ''}${x.profile ? `  profil=${x.profile}` : ''}`).join('\n')
          : '(kural yok)');
      }
      console.error('kullanım: coban rule add|list|rm'); process.exit(1);
    }
    case 'kill': {
      const r = await call('kill', { id: pos[0], removeWorktree: !!flags['rm-worktree'] });
      return print(r, () => `kapatıldı: ${pos[0]}${r.note ? ' · ' + r.note : ''}`);
    }
    case 'inbox': {
      const r = await call('inbox', {});
      const lines = [...r.messages.map((m: any) => `✉ ${m.from}: ${m.text}`), ...r.board.map((m: any) => `[ortak] ${m.from}: ${m.text}`)];
      return print(r, () => (lines.length ? lines.join('\n') : '(yeni mesaj yok)'));
    }
    case 'board': {
      const r = await call('board', { limit: num(flags.limit) });
      return print(r, () => (r.board.length ? r.board.map((m: any) => `${new Date(m.ts).toTimeString().slice(0, 5)} ${m.from}: ${m.text}`).join('\n') : '(ortak kutu boş)'));
    }
    case 'log': {
      const r = await call('log', { limit: num(flags.limit) });
      return print(r, () => r.messages.map((m: any) => `${new Date(m.ts).toTimeString().slice(0, 5)} ${m.from}→${m.to}: ${one(m.text)}`).join('\n'));
    }
    case 'history': {
      // Reads the file directly, so it works without a running coban too.
      const limit = num(flags.limit) ?? 50;
      const r = await call('history', { limit }).catch(() => ({ history: readHistory(limit) }));
      const hhmm = (ts: number) => { const d = new Date(ts); return `${d.toISOString().slice(5, 10)} ${d.toTimeString().slice(0, 5)}`; };
      return print(r, () => (r.history.length ? r.history.map((e: any) => e.kind === 'msg'
        ? `${hhmm(e.ts)} ${e.id}→${e.to}: ${one(e.text)}`
        : `${hhmm(e.ts)} ${e.id}: ${one(e.text)}${e.detail ? ' — ' + one(e.detail) : ''}`).join('\n') : '(geçmiş boş)'));
    }
    case 'usage': {
      // Works without a running coban too (then 'limited' is unknown → false).
      const r = await call('usage', {}).catch(() => ({ usage: allUsage(loadConfig()) }));
      const tok = fmtTokens;
      const line = (u: AccountUsage) => !u.limit5h
        ? [u.profileId, 'bilinmiyor', u.limited ? 'LİMİTLİ' : ''].filter(Boolean).join('  ')
        : [u.profileId, `5s ${Math.round(u.pct5h * 100)}% (${tok(u.used5h)}/${tok(u.limit5h)})`, `7g ${tok(u.used7d)}`,
          u.resetAt ? `reset ${new Date(u.resetAt).toTimeString().slice(0, 5)}` : 'reset -', u.limited ? 'LİMİTLİ' : ''].filter(Boolean).join('  ');
      return print(r, () => r.usage.map(line).join('\n'));
    }
    case 'map': console.log(repoMap(process.cwd(), pos[0] ?? '')); return;
    case 'help': case '-h': case '--help': console.log(HELP); return;
    default: console.error(HELP); process.exit(2);
  }
}

main().catch((e) => { console.error('coban: ' + e.message); process.exit(1); });

