// Cheap static look at the MCP servers an orchestrator profile would load. Reads server NAMES and whether the
// command / url is usable — never env, args, headers or tokens. No connection health is measured.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type McpServer = { name: string; ok: boolean; reason: string };

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function readJson(file: string): Dict | undefined {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return isDict(v) ? v : undefined; } catch { return undefined; }
}

function executable(file: string): boolean {
  try { if (!fs.statSync(file).isFile()) return false; fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
}

function onPath(cmd: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (cmd.includes('/') || cmd.includes(path.sep)) return executable(path.resolve(cwd, cmd.replace(/^~(?=\/|$)/, os.homedir())));
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  return (env.PATH ?? '').split(path.delimiter).some((d) => d && exts.some((e) => executable(path.join(d, cmd + e))));
}

function judge(def: unknown, disabled: boolean, cwd: string, env: NodeJS.ProcessEnv): { ok: boolean; reason: string } {
  if (disabled || (isDict(def) && def.disabled === true)) return { ok: false, reason: 'disabled' };
  if (!isDict(def)) return { ok: false, reason: 'geçersiz tanım' };
  if (typeof def.url === 'string' && def.url) {
    try { const u = new URL(def.url); return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:' ? { ok: true, reason: 'url' } : { ok: false, reason: 'url şeması' }; }
    catch { return { ok: false, reason: 'url geçersiz' }; }
  }
  if (typeof def.command === 'string' && def.command.trim()) {
    const cmd = def.command.trim();
    return onPath(cmd, cwd, env) ? { ok: true, reason: 'komut' } : { ok: false, reason: `komut yok: ${path.basename(cmd)}` };
  }
  return { ok: false, reason: 'komut/url yok' };
}

export type McpOpts = { home?: string; env?: NodeJS.ProcessEnv };

/** Config files that can define servers for this profile (also what the TUI stats for change detection). */
export function mcpFiles(configDir: string, cwd: string, o: McpOpts = {}): string[] {
  const home = o.home ?? os.homedir();
  const dir = configDir.replace(/^~(?=\/|$)/, home);
  const files = [path.join(dir, '.claude.json')];
  // with no separate profile dir Claude keeps its global config in ~/.claude.json
  const def = path.join(home, '.claude.json');
  if (!files.includes(def) && (!configDir || path.resolve(dir) === path.join(home, '.claude'))) files.push(def);
  files.push(path.join(cwd, '.mcp.json'));
  return files;
}

export function readMcpServers(configDir: string, cwd: string, o: McpOpts = {}): McpServer[] {
  try {
    const env = o.env ?? process.env;
    const found = new Map<string, { def: unknown; disabled: boolean }>();
    const files = mcpFiles(configDir, cwd, o);
    const projectFile = files[files.length - 1];
    for (const f of files) {
      const j = readJson(f);
      if (!j) continue;
      const isProj = f === projectFile;
      const proj = isDict(j.projects) && isDict(j.projects[cwd]) ? (j.projects[cwd] as Dict) : undefined;
      const off = new Set(strs(proj?.disabledMcpServers));
      const offJson = new Set(strs(proj?.disabledMcpjsonServers));
      const add = (servers: unknown, jsonSrc: boolean) => {
        if (!isDict(servers)) return;
        for (const [name, def] of Object.entries(servers)) found.set(name, { def, disabled: off.has(name) || (jsonSrc && offJson.has(name)) });
      };
      if (isProj) add(j.mcpServers, true);
      else { add(j.mcpServers, false); add(proj?.mcpServers, false); }
    }
    // .mcp.json servers are switched off through the user config's disabledMcpjsonServers
    const user = files.slice(0, -1).map(readJson).find((j) => j);
    const proj = user && isDict(user.projects) && isDict(user.projects[cwd]) ? (user.projects[cwd] as Dict) : undefined;
    const offJson = new Set(strs(proj?.disabledMcpjsonServers));
    const pj = readJson(projectFile);
    if (pj && isDict(pj.mcpServers)) for (const n of Object.keys(pj.mcpServers)) if (offJson.has(n)) found.get(n)!.disabled = true;
    return [...found].map(([name, v]) => ({ name, ...judge(v.def, v.disabled, cwd, env) }));
  } catch { return []; }
}

/** Re-reads only when a config file's mtime/size changed (call as often as you like; the TUI polls every 30s). */
export class McpWatch {
  servers: McpServer[] = [];
  private sig = '\0';
  private configDir: string; private cwd: string; private o: McpOpts;
  constructor(configDir: string, cwd: string, o: McpOpts = {}) { this.configDir = configDir; this.cwd = cwd; this.o = o; }
  /** true when the list changed. */
  refresh(): boolean {
    const sig = mcpFiles(this.configDir, this.cwd, this.o).map((f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
    if (sig === this.sig) return false;
    this.sig = sig;
    const next = readMcpServers(this.configDir, this.cwd, this.o);
    const changed = JSON.stringify(next) !== JSON.stringify(this.servers);
    this.servers = next;
    return changed;
  }
}
