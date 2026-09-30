// Settings come from environment variables first, then <home>/config.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.TABKENNEL_HOME || path.join(os.homedir(), '.tabkennel');
const FILE = path.join(HOME, 'config.json');

const DEFAULTS = {
  password: null,
  bind: '127.0.0.1',     // interface for both ports; Docker sets 0.0.0.0 and publishes to 127.0.0.1
  viewerPort: 8083,
  agentPort: 9230,
  idleMinutes: 10,       // stop a workspace's Chrome after this long unused; 0 = never
  screen: '1440x900',
  fps: 30,               // video mode frame rate
  chrome: null,          // path to a Chrome/Chromium binary; auto-detected when empty
  sandbox: 'auto',       // true | false | 'auto'
  chromeArgs: [],
};

const ENV = {
  password: 'TABKENNEL_PASSWORD', bind: 'TABKENNEL_BIND', viewerPort: 'TABKENNEL_PORT',
  agentPort: 'TABKENNEL_AGENT_PORT', idleMinutes: 'TABKENNEL_IDLE_MINUTES', screen: 'TABKENNEL_SCREEN',
  fps: 'TABKENNEL_FPS', chrome: 'TABKENNEL_CHROME', sandbox: 'TABKENNEL_SANDBOX',
};

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function load() {
  const cfg = { ...DEFAULTS, ...readFile(), home: HOME };
  for (const [k, v] of Object.entries(ENV)) if (process.env[v] !== undefined && process.env[v] !== '') cfg[k] = process.env[v];
  for (const k of ['viewerPort', 'agentPort', 'idleMinutes', 'fps']) cfg[k] = Number(cfg[k]);
  if (cfg.sandbox === 'true' || cfg.sandbox === 'false') cfg.sandbox = cfg.sandbox === 'true';
  if (!/^\d+x\d+$/.test(cfg.screen)) throw new Error(`screen must look like 1440x900, got ${cfg.screen}`);
  return cfg;
}

function save(patch) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const next = { ...readFile(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

module.exports = { load, save, HOME, FILE, DEFAULTS };
