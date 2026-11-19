// `coban doctor`: environment checks that run without the TUI and without touching the hub (never writes files).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_PATH, SOCK } from './config.ts';

export type Check = { name: string; status: 'ok' | 'warn' | 'fail'; msg: string; hint?: string };
export type DoctorOpts = { configPath?: string; sock?: string; env?: NodeJS.ProcessEnv; nodeVersion?: string };

const expand = (v: string) => v.replace(/^~(?=\/|$)/, os.homedir());

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  if (bin.includes('/')) return fs.existsSync(expand(bin));
  return (env.PATH ?? '').split(path.delimiter).some((d) => {
    if (!d) return false;
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function probeSocket(sock: string): Promise<'live' | 'stale' | 'absent'> {
  return new Promise((resolve) => {
    if (!fs.existsSync(sock)) return resolve('absent');
    const s = net.connect(sock);
    const done = (r: 'live' | 'stale') => { s.destroy(); resolve(r); };
    const t = setTimeout(() => done('stale'), 1500);
    s.on('connect', () => { clearTimeout(t); done('live'); });
    s.on('error', () => { clearTimeout(t); done('stale'); });
  });
}

export async function runDoctor(opts: DoctorOpts = {}): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? CONFIG_PATH;
  const out: Check[] = [];
  const add = (name: string, status: Check['status'], msg: string, hint?: string) => out.push({ name, status, msg, hint });

  const nodeV = opts.nodeVersion ?? process.versions.node;
  if (Number(nodeV.split('.')[0]) >= 24) add('node', 'ok', `Node ${nodeV}`);
  else add('node', 'fail', `Node ${nodeV} (>=24 gerekli)`, 'Node 24 veya üstünü kur');

  const git = spawnSync('git', ['--version'], { encoding: 'utf8', env });
  if (!git.error && git.status === 0) add('git', 'ok', git.stdout.trim());
  else add('git', 'warn', 'git bulunamadı', 'yalnızca spawn --worktree için gerekli; git kur');

  let cfg: any;
  if (!fs.existsSync(configPath)) {
    add('config', 'warn', `config yok (${configPath})`, 'ilk `coban` açılışında otomatik oluşur');
  } else {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const problems: string[] = [];
      if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.profiles) || !cfg.profiles.length) problems.push('profiles boş/eksik');
      else {
        const seen = new Set<string>();
        cfg.profiles.forEach((p: any, i: number) => {
          if (!p || typeof p.id !== 'string' || typeof p.title !== 'string' || typeof p.cmd !== 'string') problems.push(`profiles[${i}]: id/title/cmd string olmalı`);
          else if (seen.has(p.id)) problems.push(`yinelenen profil id: ${p.id}`);
          else seen.add(p.id);
        });
        if (typeof cfg.orchestrator !== 'string' || !seen.has(cfg.orchestrator)) problems.push(`orchestrator "${cfg.orchestrator}" profillerde yok`);
      }
      if (problems.length) { add('config', 'fail', `${configPath}: ${problems.join('; ')}`, 'dosyayı düzelt veya silip coban\'ın yeniden üretmesini sağla'); cfg = undefined; }
      else add('config', 'ok', `${configPath} geçerli (${cfg.profiles.length} profil)`);
    } catch (e: any) {
      add('config', 'fail', `${configPath}: JSON okunamadı (${e.message})`, 'dosyayı düzelt veya sil');
      cfg = undefined;
    }
  }

  for (const p of cfg?.profiles ?? []) {
    const bin = String(p.cmd).trim().split(/\s+/)[0];
    if (onPath(bin, env)) add(`profil ${p.id}`, 'ok', `${bin} PATH'te`);
    else add(`profil ${p.id}`, 'fail', `${bin} PATH'te yok`, `${bin} kur veya profili config'ten çıkar`);
    if (bin === 'claude') {
      const raw = p.env?.CLAUDE_CONFIG_DIR;
      if (!raw) { add(`profil ${p.id} giriş`, 'warn', 'CLAUDE_CONFIG_DIR tanımsız (varsayılan ~/.claude kullanılır)', 'ayrı hesap için env.CLAUDE_CONFIG_DIR ekle; `coban account add`'); continue; }
      const dir = expand(raw);
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch {}
      if (entries.length) add(`profil ${p.id} giriş`, 'ok', `${dir} dolu (giriş izi var)`);
      else add(`profil ${p.id} giriş`, 'warn', `${dir} yok/boş: giriş yapılmamış olabilir`, `CLAUDE_CONFIG_DIR=${dir} claude ile giriş yap`);
    }
  }

  const sock = opts.sock ?? SOCK;
  const s = await probeSocket(sock);
  if (s === 'live') add('socket', 'ok', `coban çalışıyor (${sock})`);
  else if (s === 'absent') add('socket', 'ok', `coban açık değil (${sock} yok)`);
  else add('socket', 'warn', `bayat soket (${sock})`, `rm ${sock}`);
  return out;
}

const ICON = { ok: '✓', warn: '!', fail: '✗' } as const;
export const formatDoctor = (checks: Check[]) =>
  checks.map((c) => `${ICON[c.status]} ${c.name}: ${c.msg}${c.hint && c.status !== 'ok' ? ` → ${c.hint}` : ''}`).join('\n');
export const doctorFailed = (checks: Check[]) => checks.some((c) => c.status === 'fail');
