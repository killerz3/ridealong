// Starts one Chrome and stops it cleanly so the session is saved and restored
// on the next start. On Linux it runs headed on its own virtual display (Xvfb);
// on macOS, which has no Xvfb, it runs headless.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { Config } from './config.js';
import { alive, commandLines } from './procstat.js';

const mac = process.platform === 'darwin';
export const headless = (cfg: Config) => cfg.headless === 'auto' ? process.platform !== 'linux' : cfg.headless;

export const which = (bin: string): string | null => {
  try { return execFileSync('sh', ['-c', `command -v ${bin}`]).toString().trim() || null; } catch { return null; }
};

// Real Google Chrome first: Google sign-in, X and LinkedIn distrust Chrome
// for Testing (Playwright's build) and show it an "automated testing" bar.
// A user-level install (deb unpacked to ~/.local/opt) needs no root.
// Then Playwright's Chromium (predictable, no snap confinement), then other system browsers.
export function findChrome(configured?: string | null): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  return mac ? findMacChrome() : findLinuxChrome();
}

function findLinuxChrome(): string | null {
  for (const bin of ['google-chrome-stable', 'google-chrome']) {
    const p = which(bin);
    if (p) return p;
  }
  for (const bin of ['/opt/google/chrome/chrome', path.join(os.homedir(), '.local', 'opt', 'google-chrome', 'chrome')]) {
    if (fs.existsSync(bin)) return bin;
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean) as string[];
  for (const root of roots) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)); } catch {}
    dirs.sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
    for (const d of dirs) for (const sub of ['chrome-linux', 'chrome-linux64', 'chrome-linux-arm64']) {
      const bin = path.join(root, d, sub, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  for (const bin of ['chromium', 'chromium-browser']) {
    const p = which(bin);
    if (p && !p.startsWith('/snap/')) return p;
  }
  return null;
}

function findMacChrome(): string | null {
  const apps = [['Google Chrome.app', 'Google Chrome'], ['Chromium.app', 'Chromium']];
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    for (const [app, bin] of apps) {
      const p = path.join(dir, app, 'Contents', 'MacOS', bin);
      if (fs.existsSync(p)) return p;
    }
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean) as string[];
  for (const root of roots) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)); } catch {}
    dirs.sort((a, b) => +b.split('-')[1] - +a.split('-')[1]);
    for (const d of dirs) for (const sub of ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac']) {
      for (const [app, bin] of [['Google Chrome for Testing.app', 'Google Chrome for Testing'], ['Chromium.app', 'Chromium']]) {
        const p = path.join(root, d, sub, app, 'Contents', 'MacOS', bin);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

// Headless Chrome calls itself HeadlessChrome and hides its client hints, and
// sites like Google then refuse to sign you in. Look like the normal browser.
const uaCache = new Map<string, string>();
function desktopUA(bin: string) {
  if (!uaCache.has(bin)) {
    const v = (spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout || '').match(/(\d+)\.\d+\.\d+/);
    const platform = mac ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
    uaCache.set(bin, `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v ? v[1] : '140'}.0.0.0 Safari/537.36`);
  }
  return uaCache.get(bin)!;
}

export const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Chrome's sandbox can't start as root, under no-new-privileges, or where
// AppArmor blocks unprivileged user namespaces (Ubuntu 23.10+). If this guess
// is wrong, launch() retries without the sandbox anyway.
export function sandboxWorks() {
  if (process.platform !== 'linux') return true;
  if (process.getuid && process.getuid() === 0) return false;
  if (/^NoNewPrivs:\s*1/m.test(readText('/proc/self/status'))) return false;
  if (readText('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim() === '1') return false;
  if (readText('/proc/sys/kernel/unprivileged_userns_clone').trim() === '0') return false;
  return true;
}

function smallShm() {
  if (process.platform !== 'linux') return false;
  try { const s = fs.statfsSync('/dev/shm'); return s.blocks * s.bsize < 512 * 1024 * 1024; } catch { return true; }
}

const tail = () => {
  const lines: string[] = [];
  return {
    push: (d: unknown) => { lines.push(...String(d).split('\n').filter(Boolean)); lines.splice(0, lines.length - 15); },
    text: () => lines.join('\n'),
  };
};

function startXvfb(screen: string): Promise<{ proc: ChildProcess; display: string }> {
  return new Promise((resolve, reject) => {
    const x = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${screen}x24`, '-nolisten', 'tcp', '-nocursor'],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    const err = tail();
    x.stderr!.on('data', err.push);
    const t = setTimeout(() => { x.kill('SIGKILL'); reject(new Error('Xvfb did not start:\n' + err.text())); }, 8000);
    x.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error('Xvfb is not installed (apt install xvfb)') : e); });
    x.on('exit', () => { clearTimeout(t); reject(new Error('Xvfb exited:\n' + err.text())); });
    (x.stdio[3] as NodeJS.ReadableStream).once('data', d => {
      clearTimeout(t); x.removeAllListeners('exit');
      resolve({ proc: x, display: ':' + String(d).trim() });
    });
  });
}

export interface Chrome {
  proc: ChildProcess;
  xvfbPid: number | undefined;
  display: string | null; // null when headless: no display to capture video from
  http: string;
  width: number;
  height: number;
  wsUrl(): Promise<string>;
  stop(): Promise<void>;
}

export async function launch({ profile, cfg }: { profile: string; cfg: Config }): Promise<Chrome> {
  const auto = cfg.sandbox === 'auto';
  try {
    return await start({ profile, cfg, sandbox: auto ? sandboxWorks() : cfg.sandbox === true });
  } catch (e) {
    if (!auto || !/No usable sandbox|sandbox/i.test((e as Error).message)) throw e;
    return start({ profile, cfg, sandbox: false });
  }
}

// If ridealong died without stopping its browsers (crash, kill -9), their
// Chrome and Xvfb are still running. Never start a second Chrome on the same
// profile: find leftovers by profile path and by the pid file, and stop them.
export async function killStale(profile: string, pidFile: string) {
  const victims = new Set<number>(), displays = new Set<number>();
  let pids: { chrome?: number; xvfb?: number } = {};
  try { pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch {}
  const cmds = commandLines();
  if (pids.chrome && /chrom/i.test(cmds.get(+pids.chrome) || '')) victims.add(+pids.chrome);
  if (pids.xvfb && /Xvfb/.test(cmds.get(+pids.xvfb) || '')) displays.add(+pids.xvfb);
  // Chrome rewrites its process title, so args may be joined by spaces, not NULs
  const flag = `--user-data-dir=${profile}`;
  for (const [pid, cmd] of cmds) {
    const i = cmd.indexOf(flag);
    if (i >= 0 && /^[\0 ]?$/.test(cmd.charAt(i + flag.length))) victims.add(pid);
  }
  victims.delete(process.pid);
  const living = (set: Set<number>) => [...set].filter(alive);
  const stop = async (set: Set<number>, graceMs: number) => {
    const signal = (sig: NodeJS.Signals) => living(set).forEach(pid => { try { process.kill(pid, sig); } catch {} });
    signal('SIGTERM');
    for (let i = 0; i < graceMs / 100 && living(set).length; i++) await sleep(100);
    signal('SIGKILL');
    for (let i = 0; i < 20 && living(set).length; i++) await sleep(100);
  };
  // Chrome first (SIGTERM lets it save open tabs), then its display
  if (victims.size) await stop(victims, 5000);
  if (displays.size) await stop(displays, 1000);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function start({ profile, cfg, sandbox }: { profile: string; cfg: Config; sandbox: boolean }): Promise<Chrome> {
  const bin = findChrome(cfg.chrome);
  if (!bin) throw new Error('no Chrome found: run `ridealong setup` or set "chrome" in config');
  const [w, h] = cfg.screen.split('x').map(Number);
  const pidFile = path.join(path.dirname(profile), 'pids.json');

  fs.mkdirSync(profile, { recursive: true });
  await killStale(profile, pidFile);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) fs.rmSync(path.join(profile, f), { force: true });

  const hl = headless(cfg);
  const xvfb = hl ? null : await startXvfb(cfg.screen);
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--window-size=${Math.min(w, 1440)},${Math.min(h, 900)}`, '--window-position=0,0',
    ...(hl ? ['--headless=new', `--screen-info={0,0 ${w}x${h}}`] : []),
    ...(hl && !cfg.chromeArgs.some(a => a.startsWith('--user-agent=')) ? [`--user-agent=${desktopUA(bin)}`] : []),
    // like --password-store=basic on Linux: no keychain prompts for a profile the user never opens directly
    ...(mac ? ['--use-mock-keychain'] : []),
    '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    '--restore-last-session', '--hide-crash-restore-bubble',
    // agents' tabs sit in unfocused windows; keep them rendering at full speed
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter',
    // the debugging port sets navigator.webdriver, and sites like Google then
    // refuse to sign you in ("This browser or app may not be secure")
    '--disable-blink-features=AutomationControlled',
    '--test-type', // hides the "unsupported command-line flag" bar
    ...(sandbox ? [] : ['--no-sandbox']),
    ...(smallShm() ? ['--disable-dev-shm-usage'] : []),
    ...cfg.chromeArgs,
  ];
  const proc = spawn(bin, args, { env: xvfb ? { ...process.env, DISPLAY: xvfb.display } : process.env, stdio: ['ignore', 'ignore', 'pipe'] });
  try { fs.writeFileSync(pidFile, JSON.stringify({ chrome: proc.pid, xvfb: xvfb?.proc.pid })); } catch {}
  const err = tail();
  proc.stderr!.on('data', err.push);

  let exited = false;
  proc.on('exit', () => { exited = true; xvfb?.proc.kill(); });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port: number | undefined;
  for (let i = 0; i < 300 && !port && !exited; i++) {
    await sleep(100);
    try { port = +fs.readFileSync(portFile, 'utf8').split('\n')[0] || undefined; } catch {}
  }
  if (!port) {
    proc.kill('SIGKILL'); xvfb?.proc.kill();
    const lines = err.text().split('\n');
    const fatal = lines.filter(l => /FATAL|error while loading/.test(l)).map(l => l.replace(/^\[[^\]]*\]\s*/, ''));
    throw new Error('Chrome did not start: ' + (fatal.length ? fatal.join('\n') : lines.slice(-5).join('\n')));
  }
  const http = `http://127.0.0.1:${port}`;

  const chrome: Chrome = {
    proc, xvfbPid: xvfb?.proc.pid, display: xvfb?.display ?? null, http, width: w, height: h,
    wsUrl: async () => (await (await fetch(`${http}/json/version`)).json()).webSocketDebuggerUrl,
    // Browser.close lets Chrome write its session for --restore-last-session
    async stop() {
      if (exited) return;
      const gone = new Promise(r => proc.once('exit', r));
      try {
        const ws = new WebSocket(await chrome.wsUrl());
        await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); });
        ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch { proc.kill('SIGTERM'); }
      const t = setTimeout(() => proc.kill('SIGKILL'), 8000);
      await gone; clearTimeout(t);
    },
  };
  return chrome;
}
