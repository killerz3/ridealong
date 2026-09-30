// Starts one headed Chrome on its own virtual display (Xvfb) and stops it
// cleanly so the session is saved and restored on the next start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const which = bin => { try { return execFileSync('sh', ['-c', `command -v ${bin}`]).toString().trim() || null; } catch { return null; } };

// Playwright's Chromium first (predictable, no snap confinement), then system browsers.
function findChrome(configured) {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), '.cache', 'ms-playwright')].filter(Boolean);
  for (const root of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(d => /^chromium-\d+$/.test(d)); } catch {}
    dirs.sort((a, b) => b.split('-')[1] - a.split('-')[1]);
    for (const d of dirs) for (const sub of ['chrome-linux', 'chrome-linux64', 'chrome-linux-arm64']) {
      const bin = path.join(root, d, sub, 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  }
  for (const bin of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const p = which(bin);
    if (p && !p.startsWith('/snap/')) return p;
  }
  return null;
}

// Chrome's sandbox can't start as root, under no-new-privileges, or where
// AppArmor blocks unprivileged user namespaces (Ubuntu 23.10+). If this guess
// is wrong, launch() retries without the sandbox anyway.
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function sandboxWorks() {
  if (process.getuid && process.getuid() === 0) return false;
  if (/^NoNewPrivs:\s*1/m.test(read('/proc/self/status'))) return false;
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim() === '1') return false;
  if (read('/proc/sys/kernel/unprivileged_userns_clone').trim() === '0') return false;
  return true;
}

function smallShm() {
  try { const s = fs.statfsSync('/dev/shm'); return s.blocks * s.bsize < 512 * 1024 * 1024; } catch { return true; }
}

const tail = () => {
  const lines = [];
  return { push: d => { lines.push(...String(d).split('\n').filter(Boolean)); lines.splice(0, lines.length - 15); }, text: () => lines.join('\n') };
};

function startXvfb(screen) {
  return new Promise((resolve, reject) => {
    const x = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${screen}x24`, '-nolisten', 'tcp', '-nocursor'],
      { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    const err = tail();
    x.stderr.on('data', err.push);
    const t = setTimeout(() => { x.kill('SIGKILL'); reject(new Error('Xvfb did not start:\n' + err.text())); }, 8000);
    x.on('error', e => { clearTimeout(t); reject(e.code === 'ENOENT' ? new Error('Xvfb is not installed (apt install xvfb)') : e); });
    x.on('exit', () => { clearTimeout(t); reject(new Error('Xvfb exited:\n' + err.text())); });
    x.stdio[3].once('data', d => { clearTimeout(t); x.removeAllListeners('exit'); resolve({ proc: x, display: ':' + String(d).trim() }); });
  });
}

async function launch({ profile, cfg }) {
  const auto = cfg.sandbox === 'auto';
  try {
    return await start({ profile, cfg, sandbox: auto ? sandboxWorks() : cfg.sandbox });
  } catch (e) {
    if (!auto || !/No usable sandbox|sandbox/i.test(e.message)) throw e;
    return start({ profile, cfg, sandbox: false });
  }
}

// If tabkennel died without stopping its browsers (crash, kill -9), their
// Chrome and Xvfb are still running. Never start a second Chrome on the same
// profile: find leftovers by profile path and by the pid file, and stop them.
async function killStale(profile, pidFile) {
  const victims = new Set();
  let pids = {};
  try { pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch {}
  for (const pid of Object.values(pids)) if (/Xvfb|chrome/i.test(read(`/proc/${pid}/cmdline`))) victims.add(+pid);
  let procs = [];
  try { procs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch {}
  // Chrome rewrites its process title, so args may be joined by spaces, not NULs
  const flag = `--user-data-dir=${profile}`;
  for (const pid of procs) {
    const cmd = read(`/proc/${pid}/cmdline`);
    const i = cmd.indexOf(flag);
    if (i >= 0 && /^[\0 ]?$/.test(cmd.charAt(i + flag.length))) victims.add(+pid);
  }
  victims.delete(process.pid);
  if (!victims.size) return;
  for (const pid of victims) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (let i = 0; i < 30 && [...victims].some(pid => fs.existsSync(`/proc/${pid}`) && !/zombie|\) Z /.test(read(`/proc/${pid}/stat`))); i++) {
    await new Promise(r => setTimeout(r, 100));
  }
}

async function start({ profile, cfg, sandbox }) {
  const bin = findChrome(cfg.chrome);
  if (!bin) throw new Error('no Chrome found: run `tabkennel setup` or set "chrome" in config');
  const [w, h] = cfg.screen.split('x').map(Number);
  const pidFile = path.join(path.dirname(profile), 'pids.json');

  fs.mkdirSync(profile, { recursive: true });
  await killStale(profile, pidFile);
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) fs.rmSync(path.join(profile, f), { force: true });

  const xvfb = await startXvfb(cfg.screen);
  const args = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--window-size=${Math.min(w, 1440)},${Math.min(h, 900)}`, '--window-position=0,0',
    '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    '--restore-last-session', '--hide-crash-restore-bubble',
    // agents' tabs sit in unfocused windows; keep them rendering at full speed
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter',
    ...(sandbox ? [] : ['--no-sandbox', '--test-type']), // --test-type hides the "unsupported flag" bar
    ...(smallShm() ? ['--disable-dev-shm-usage'] : []),
    ...cfg.chromeArgs,
  ];
  const proc = spawn(bin, args, { env: { ...process.env, DISPLAY: xvfb.display }, stdio: ['ignore', 'ignore', 'pipe'] });
  try { fs.writeFileSync(pidFile, JSON.stringify({ chrome: proc.pid, xvfb: xvfb.proc.pid })); } catch {}
  const err = tail();
  proc.stderr.on('data', err.push);

  let exited = false;
  proc.on('exit', () => { exited = true; xvfb.proc.kill(); });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 300 && !port && !exited; i++) {
    await new Promise(r => setTimeout(r, 100));
    try { port = +fs.readFileSync(portFile, 'utf8').split('\n')[0] || undefined; } catch {}
  }
  if (!port) {
    proc.kill('SIGKILL'); xvfb.proc.kill();
    const lines = err.text().split('\n');
    const fatal = lines.filter(l => /FATAL|error while loading/.test(l)).map(l => l.replace(/^\[[^\]]*\]\s*/, ''));
    throw new Error('Chrome did not start: ' + (fatal.length ? fatal.join('\n') : lines.slice(-5).join('\n')));
  }
  const http = `http://127.0.0.1:${port}`;

  const chrome = {
    proc, display: xvfb.display, http, width: w, height: h,
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

module.exports = { launch, findChrome, sandboxWorks, which };
