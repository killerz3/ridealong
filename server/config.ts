// Settings come from environment variables first, then <home>/config.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.TABKENNEL_HOME || path.join(os.homedir(), '.tabkennel');
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
  chromeArgs: [],
};

const ENV: Partial<Record<keyof Config, string>> = {
  password: 'TABKENNEL_PASSWORD', bind: 'TABKENNEL_BIND', viewerPort: 'TABKENNEL_PORT',
  agentPort: 'TABKENNEL_AGENT_PORT', idleMinutes: 'TABKENNEL_IDLE_MINUTES', screen: 'TABKENNEL_SCREEN',
  fps: 'TABKENNEL_FPS', chrome: 'TABKENNEL_CHROME', sandbox: 'TABKENNEL_SANDBOX',
};

function readFile(): Partial<Config> {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function load(): Config {
  const raw: Record<string, unknown> = { ...DEFAULTS, ...readFile(), home: HOME };
  for (const [k, v] of Object.entries(ENV)) if (process.env[v] !== undefined && process.env[v] !== '') raw[k] = process.env[v];
  for (const k of ['viewerPort', 'agentPort', 'idleMinutes', 'fps']) raw[k] = Number(raw[k]);
  if (raw.sandbox === 'true' || raw.sandbox === 'false') raw.sandbox = raw.sandbox === 'true';
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
