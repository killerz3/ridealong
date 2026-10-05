// Settings come from environment variables first, then <home>/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ridealong was called tabkennel until v0.3: its env vars still work and its
// data folder is moved over on first run.
const env = (name: string) => process.env['RIDEALONG_' + name] ?? process.env['TABKENNEL_' + name];

function defaultHome() {
  const home = path.join(os.homedir(), '.ridealong'), old = path.join(os.homedir(), '.tabkennel');
  if (!fs.existsSync(home) && fs.existsSync(old)) try { fs.renameSync(old, home); } catch {}
  return home;
}

export const HOME = env('HOME') || defaultHome();
export const FILE = path.join(HOME, 'config.json');

export interface Config {
  password: string | null;
  bind: string;            // interface for both ports; Docker sets 0.0.0.0 and publishes to 127.0.0.1
  viewerPort: number;
  agentPort: number;
  idleMinutes: number;     // stop a workspace's Chrome after this long unused; 0 = never
  screen: string;          // virtual display size per workspace (the largest a page can be)
  fps: number;             // video mode frame rate
  chrome: string | null;   // path to a Chrome/Chromium binary; auto-detected when empty
  sandbox: boolean | 'auto';
  headless: boolean | 'auto'; // auto: headed on Linux (Xvfb), headless elsewhere
  chromeArgs: string[];
  home: string;
}

export const DEFAULTS: Omit<Config, 'home'> = {
  password: null,
  bind: '127.0.0.1',
  viewerPort: 8083,
  agentPort: 9230,
  idleMinutes: 10,
  screen: '1920x1200',
  fps: 30,
  chrome: null,
  sandbox: 'auto',
  headless: 'auto',
  chromeArgs: [],
};

const ENV: Partial<Record<keyof Config, string>> = {
  password: 'PASSWORD', bind: 'BIND', viewerPort: 'PORT', agentPort: 'AGENT_PORT',
  idleMinutes: 'IDLE_MINUTES', screen: 'SCREEN', fps: 'FPS', chrome: 'CHROME', sandbox: 'SANDBOX', headless: 'HEADLESS',
};

function readFile(): Partial<Config> {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function load(): Config {
  const raw: Record<string, unknown> = { ...DEFAULTS, ...readFile(), home: HOME };
  for (const [k, v] of Object.entries(ENV)) { const val = env(v); if (val !== undefined && val !== '') raw[k] = val; }
  for (const k of ['viewerPort', 'agentPort', 'idleMinutes', 'fps']) raw[k] = Number(raw[k]);
  for (const k of ['sandbox', 'headless']) {
    const v = String(raw[k]).toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) raw[k] = true;
    else if (['false', '0', 'no', 'off'].includes(v)) raw[k] = false;
    else if (v !== 'auto') throw new Error(`${k} must be true, false or auto, got ${raw[k]}`);
  }
  const cfg = raw as unknown as Config;
  if (!/^\d+x\d+$/.test(cfg.screen)) throw new Error(`screen must look like 1440x900, got ${cfg.screen}`);
  return cfg;
}

export function save(patch: Partial<Config>) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const next = { ...readFile(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
