import net from 'node:net';
import { loadConfig, SOCK } from './config.ts';
import { repoMap, snippets } from './context.ts';

const HELP = `coban — çok hesaplı agent orkestratörü

  coban [--cwd dizin]                 arayüzü aç (orkestratörü graf alanındaki + ile seç)

Agent'ların içinden (veya başka bir terminalden):
  coban agents                        agent listesi ve durumları
  coban spawn <profil> "<görev>" [--name ad] [--cwd dizin] [--ctx yer]...
                                      --ctx: "dosya:10-80" | "dosya#sembol1,sembol2" | "dosya"
                                      ilgili kodu satır numaralı olarak görevin içine ekler (send/post'ta da var)
  coban map [alt-dizin]               repo haritası: dosyalar, satır sayıları, semboller:satır
  coban send <id> "<mesaj>"           (post ile aynı)
  coban post <id|user|all> "<mesaj>"  all = ortak kutu (herkes görür)
  coban wait [id...] [--timeout sn]   biri durunca / mesaj gelince döner
  coban read <id> [--lines n] [--scrollback] [--raw]
  coban key <id> <tuş...>             enter esc up down tab 1 2 y ...
  coban kill <id>
  coban inbox                         özel mesajlar + ortak kutudaki yeniler
  coban board [--limit n]             ortak kutunun son notları
  coban log [--limit n]

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

const BOOL_FLAGS = ['scrollback', 'raw', 'json'];

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
  const agentLine = (a: any) =>
    [a.id, `${a.profile}${a.model ? '/' + short(a.model) : ''}`, a.role === 'orchestrator' ? '★' : a.role === 'manual' ? 'manuel' : '', a.status,
      a.unreadMessages ? `✉${a.unreadMessages}` : '', a.boardUnread ? `▤${a.boardUnread}` : '', a.cwd ? `cwd=${a.cwd}` : '', a.task ? `"${a.task}"` : '']
      .filter(Boolean).join('  ');

  switch (cmd) {
    case 'agents': {
      const r = await call('agents', {});
      return print(r, () => [...r.agents.map(agentLine), 'profiller: ' + r.profiles.map((p: any) => `${p.id}${p.model ? '/' + short(p.model) : ''}`).join(' ')].join('\n'));
    }
    case 'spawn': {
      const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
      const r = await call('spawn', { profile: pos[0], task: pos.slice(1).join(' ') + snippets(ctx, cwd), name: flags.name, cwd: flags.cwd });
      return print(r, () => `açıldı: ${r.id}`);
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
    case 'kill': { const r = await call('kill', { id: pos[0] }); return print(r, () => `kapatıldı: ${pos[0]}`); }
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
    case 'map': console.log(repoMap(process.cwd(), pos[0] ?? '')); return;
    case 'help': case '-h': case '--help': console.log(HELP); return;
    default: console.error(HELP); process.exit(2);
  }
}

main().catch((e) => { console.error('coban: ' + e.message); process.exit(1); });

