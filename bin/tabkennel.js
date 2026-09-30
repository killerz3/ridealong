#!/usr/bin/env node
// tabkennel command line: setup, run, and connect agents.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');
const config = require('../src/config');
const { findChrome, which } = require('../src/chrome');
const pkg = require('../package.json');

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i >= 0 ? (argv.splice(i, 1), true) : false; };
const YES = flag('--yes') || flag('-y');
const opt = (name, short) => {
  const i = argv.findIndex(a => a === name || a === short);
  if (i < 0) return undefined;
  const v = argv[i + 1]; argv.splice(i, 2); return v;
};

const c = process.stdout.isTTY ? { b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m` }
  : { b: s => s, d: s => s, g: s => s, r: s => s, y: s => s };
const ok = s => console.log(`  ${c.g('✓')} ${s}`);
const bad = s => console.log(`  ${c.r('✗')} ${s}`);
const warn = s => console.log(`  ${c.y('!')} ${s}`);

const HELP = `${c.b('tabkennel')} ${pkg.version}: one logged-in browser for you and your agents

${c.b('Usage')}
  tabkennel setup              guided first-time setup (browser, password, background service)
  tabkennel start              run in the foreground
  tabkennel connect <agent>    print how to plug an agent in   [-w workspace]
  tabkennel status             workspaces and whether they're awake
  tabkennel wake|sleep <ws>    start or stop a workspace's browser now
  tabkennel doctor             check that everything tabkennel needs is installed
  tabkennel password           change the viewer password

Settings live in ${config.FILE}
(env vars TABKENNEL_PASSWORD, TABKENNEL_PORT, TABKENNEL_AGENT_PORT, TABKENNEL_IDLE_MINUTES, … override it)`;

function ask(q, { hidden = false, def = '' } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim() || def); });
  });
}
const yes = async (q, def = true) => {
  if (!process.stdin.isTTY || YES) return def;
  const a = (await ask(`${q} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') : def;
};

async function api(cfg, p, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${cfg.agentPort}${p}`, { method });
  return res.json();
}

function checks(cfg) {
  const out = {};
  out.xvfb = which('Xvfb');
  out.chrome = findChrome(cfg.chrome);
  out.ffmpeg = which('ffmpeg');
  if (out.ffmpeg) {
    const enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '';
    const dev = spawnSync('ffmpeg', ['-hide_banner', '-devices'], { encoding: 'utf8' }).stdout || '';
    out.video = /libx264/.test(enc) && /x11grab/.test(dev);
  }
  return out;
}

const installHint = pkgs => {
  if (which('apt-get')) return `sudo apt-get install -y ${pkgs.apt}`;
  if (which('dnf')) return `sudo dnf install -y ${pkgs.dnf}`;
  if (which('pacman')) return `sudo pacman -S ${pkgs.pacman}`;
  return `install ${pkgs.apt} with your package manager`;
};
const XVFB = { apt: 'xvfb', dnf: 'xorg-x11-server-Xvfb', pacman: 'xorg-server-xvfb' };
const FFMPEG = { apt: 'ffmpeg', dnf: 'ffmpeg', pacman: 'ffmpeg' };

function report(cfg) {
  const r = checks(cfg);
  r.xvfb ? ok('Xvfb (virtual display)') : bad(`Xvfb is missing: ${installHint(XVFB)}`);
  r.chrome ? ok(`Chromium: ${r.chrome}`) : bad('no Chromium yet: `tabkennel setup` downloads one');
  if (!r.ffmpeg) warn(`ffmpeg is missing, so video mode is off (optional): ${installHint(FFMPEG)}`);
  else if (!r.video) warn('ffmpeg has no libx264/x11grab, so video mode is off (optional)');
  else ok('ffmpeg with H.264 (video mode available)');
  cfg.password ? ok('viewer password is set') : bad('no viewer password: run `tabkennel setup` or `tabkennel password`');
  return r;
}

function installChromium() {
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  return r.status === 0;
}

const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'tabkennel.service');
function installService() {
  const unit = `[Unit]
Description=tabkennel: shared browser for you and your agents
After=network.target

[Service]
ExecStart=${process.execPath} ${path.resolve(__dirname, 'tabkennel.js')} start
Environment=PATH=${process.env.PATH}
Restart=on-failure
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=default.target
`;
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit);
  const sc = (...a) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
  sc('daemon-reload');
  const r = sc('enable', '--now', 'tabkennel');
  if (r.status !== 0) { bad(`systemctl failed: ${(r.stderr || '').trim()}`); return false; }
  ok(`background service installed (${unitPath})`);
  const linger = spawnSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { encoding: 'utf8' }).stdout || '';
  if (!/Linger=yes/.test(linger)) warn(`to keep it running after you log out: sudo loginctl enable-linger ${os.userInfo().username}`);
  return true;
}

function connectText(cfg, agent = 'my-agent', ws = 'default') {
  const url = `ws://127.0.0.1:${cfg.agentPort}/${ws}/${agent}/devtools/browser`;
  return `${c.b(`Connect "${agent}" to workspace "${ws}"`)}

  ${c.b('Claude Code')}
    claude mcp add browser -- npx -y chrome-devtools-mcp@latest --wsEndpoint ${url}

  ${c.b('Any MCP client')} (JSON config)
    { "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest", "--wsEndpoint", "${url}"] }

  ${c.b('Playwright')}
    const browser = await chromium.connectOverCDP('http://127.0.0.1:${cfg.agentPort}/${ws}/${agent}');

  ${c.b('Puppeteer')}
    const browser = await puppeteer.connect({ browserWSEndpoint: '${url}' });

${c.d(`The agent only sees tabs it opens. The workspace starts on connect and is created if new.
Give each agent its own name; use -w to pick a workspace.`)}`;
}

async function setup() {
  let cfg = config.load();
  console.log(`\n${c.b('tabkennel setup')}  ${c.d(config.HOME)}\n`);
  let r = report(cfg);
  console.log();
  if (!r.chrome) {
    if (await yes('Download Chromium for tabkennel now (~170 MB, no root needed)?')) {
      if (!installChromium()) { bad('Chromium download failed; see above'); process.exit(1); }
      ok(`Chromium: ${findChrome()}`);
    }
  }
  if (!cfg.password) {
    const custom = process.stdin.isTTY && !YES
      ? await ask('Choose a viewer password (Enter to generate one): ', { hidden: true }) : '';
    const password = custom || crypto.randomBytes(12).toString('base64url');
    config.save({ password });
    ok(custom ? 'password saved' : `generated password: ${c.b(password)}  ${c.d('(saved in config.json)')}`);
    cfg = config.load();
  }
  if (!r.xvfb) {
    bad(`tabkennel needs Xvfb: ${installHint(XVFB)}, then run setup again`);
    process.exit(1);
  }
  console.log();
  const hasSystemd = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' }).status !== null && which('systemctl');
  let running = false;
  if (hasSystemd && await yes('Run tabkennel in the background and start it on boot (systemd user service)?')) running = installService();
  console.log(`\n${c.b('Done.')} ${running ? '' : 'Start it with ' + c.b('tabkennel start') + '.'}

  Open the viewer: ${c.b(`http://127.0.0.1:${cfg.viewerPort}`)}
  ${c.d(`On a remote server: ssh -L ${cfg.viewerPort}:127.0.0.1:${cfg.viewerPort} <server>, or put it behind a tunnel (see README).`)}

${connectText(cfg)}
`);
}

(async () => {
  const cmd = argv.shift() || 'help';
  let cfg;
  try { cfg = config.load(); } catch (e) { bad(e.message); process.exit(1); }
  switch (cmd) {
    case 'start': case 'serve':
      try { await require('../src/server').serve(cfg); } catch (e) { bad(e.message); process.exit(1); }
      return;
    case 'setup': return setup();
    case 'doctor': { const r = report(cfg); process.exit(r.xvfb && r.chrome && cfg.password ? 0 : 1); }
    case 'connect': {
      const ws = opt('--workspace', '-w') || 'default';
      console.log(connectText(cfg, argv[0] || 'my-agent', ws));
      return;
    }
    case 'status': {
      let list;
      try { list = await api(cfg, '/api/workspaces'); } catch { bad(`tabkennel is not running (nothing on port ${cfg.agentPort})`); process.exit(1); }
      console.log(`${c.b('tabkennel')} viewer http://127.0.0.1:${cfg.viewerPort}\n`);
      for (const w of list) {
        const dot = w.state === 'awake' ? c.g('●') : w.state === 'asleep' ? c.d('○') : c.y('◐');
        const extra = [w.agents.length && `agents: ${w.agents.join(', ')}`, w.viewers && `${w.viewers} viewer(s)`,
          w.sleepsIn != null && `sleeps in ${Math.ceil(w.sleepsIn / 60)} min`, w.error && c.r(w.error)].filter(Boolean).join(' · ');
        console.log(`  ${dot} ${w.name.padEnd(16)} ${w.state.padEnd(9)} ${c.d(extra)}`);
      }
      return;
    }
    case 'wake': case 'sleep': {
      if (!argv[0]) { bad(`usage: tabkennel ${cmd} <workspace>`); process.exit(1); }
      try { const w = await api(cfg, `/api/workspaces/${argv[0]}/${cmd}`, 'POST'); w.error ? bad(w.error) : ok(`${w.name} is ${w.state}`); } catch { bad('tabkennel is not running'); process.exit(1); }
      return;
    }
    case 'password': {
      const p = argv[0] || await ask('New viewer password: ', { hidden: true });
      if (!p) process.exit(1);
      config.save({ password: p });
      ok('saved; restart tabkennel to apply (systemctl --user restart tabkennel)');
      return;
    }
    case '-v': case '--version': return console.log(pkg.version);
    default: console.log(HELP);
  }
})();
