import net from 'node:net';
import { loadConfig, SOCK } from './config.ts';

const HELP = `coban — çok hesaplı agent orkestratörü

  coban [--cwd dizin]                 arayüzü aç (orkestratör otomatik başlar)

Agent'ların içinden (veya başka bir terminalden):
  coban agents                        agent listesi ve durumları
  coban spawn <profil> "<görev>" [--name ad] [--cwd dizin]
  coban send <id> "<mesaj>"           (post ile aynı)
  coban post <id|user> "<mesaj>"
  coban wait [id...] [--timeout sn]   biri durunca / mesaj gelince döner
  coban read <id> [--lines n] [--scrollback]
  coban key <id> <tuş...>             enter esc up down tab 1 2 y ...
  coban kill <id>
  coban inbox
  coban log [--limit n]`;

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

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && k !== 'scrollback') flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
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
    hub.spawn({ profile: hub.cfg.orchestrator, role: 'orchestrator' });
    const quit = () => { tui.stop(); hub.shutdown(); process.exit(0); };
    process.on('SIGTERM', quit);
    process.on('SIGHUP', quit);
    process.on('uncaughtException', (e) => { tui.stop(); hub.shutdown(); console.error(e); process.exit(1); });
    return;
  }

  let r: any;
  switch (cmd) {
    case 'agents': r = await call('agents', {}); break;
    case 'spawn': r = await call('spawn', { profile: pos[0], task: pos.slice(1).join(' '), name: flags.name, cwd: flags.cwd }); break;
    case 'send': case 'post': r = await call('post', { to: pos[0], text: pos.slice(1).join(' ') }); break;
    case 'wait': r = await call('wait', { ids: pos, timeout: num(flags.timeout) }); break;
    case 'read': {
      r = await call('read', { id: pos[0], lines: num(flags.lines), scrollback: !!flags.scrollback });
      console.log(`[${r.id} · ${r.status}]\n${r.screen}`);
      return;
    }
    case 'key': r = await call('key', { id: pos[0], keys: pos.slice(1) }); break;
    case 'kill': r = await call('kill', { id: pos[0] }); break;
    case 'inbox': r = await call('inbox', {}); break;
    case 'log': r = await call('log', { limit: num(flags.limit) }); break;
    case 'help': case '-h': case '--help': console.log(HELP); return;
    default: console.error(HELP); process.exit(2);
  }
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => { console.error('coban: ' + e.message); process.exit(1); });

