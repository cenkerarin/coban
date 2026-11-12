import { execFile } from 'node:child_process';
import type { Config } from './config.ts';

export type Notifier = (title: string, text: string) => void;

// macOS notification via osascript. Text goes in as argv (never interpolated into the script).
// Off when config `notify` is false, off macOS, or COBAN_NO_NOTIFY is set. Failures are ignored.
export function notify(cfg: Pick<Config, 'notify'>, title: string, text: string, run: typeof execFile = execFile): boolean {
  if (cfg.notify === false || process.platform !== 'darwin' || process.env.COBAN_NO_NOTIFY) return false;
  try {
    const p = run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run',
      text.slice(0, 200), title.slice(0, 80)], () => {});
    p?.unref?.();
    return true;
  } catch { return false; }
}
