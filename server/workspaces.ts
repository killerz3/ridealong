// A workspace is its own Chrome profile (own logins) running in its own
// Chrome (on Linux, with its own virtual display). It starts when someone needs it and is stopped
// after idleMinutes without a viewer or agent activity, so idle RAM is ~0.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as chrome from './chrome.js';
import type { Chrome } from './chrome.js';
import type { Config } from './config.js';
import { Owners } from './owners.js';
import { TabMap } from './tabmap.js';
import { Downloads } from './downloads.js';
import { treeMemoryMB } from './procstat.js';
import { WORKSPACE_NAME, type Activity, type ActivityKind, type WorkspaceInfo, type WorkspaceState } from '../shared/protocol.js';

interface Settings { idleMinutes?: number; blocked?: string[] }
const ACTIVITY_KEEP = 200;
let activitySeq = 0;

export class Workspace extends EventEmitter {
  dir: string;
  profile: string;
  owners: Owners;
  downloads: Downloads;
  settings: Settings;
  state: WorkspaceState = 'asleep';
  chrome: Chrome | null = null;
  tabmap: TabMap | null = null;
  leases = new Set<object>();  // viewers looking at this workspace
  agents = new Map<string, { connections: number; lastActive: number }>();
  activity: Activity[] = [];
  lastActive = Date.now();
  error: string | null = null;
  memoryMB: number | null = null;
  lastLogged?: WorkspaceState;
  private settingsFile: string;
  private waking: Promise<Chrome> | null = null;
  private sleeping: Promise<void> | null = null;

  constructor(public manager: Manager, public name: string) {
    super();
    this.setMaxListeners(0);
    this.dir = path.join(manager.root, name);
    this.profile = path.join(this.dir, 'profile');
    fs.mkdirSync(this.dir, { recursive: true });
    this.owners = new Owners(path.join(this.dir, 'owners.json'));
    this.downloads = new Downloads(path.join(this.dir, 'downloads'));
    this.settingsFile = path.join(this.dir, 'settings.json');
    try { this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { this.settings = {}; }
  }

  get idleMinutes(): number { return this.settings.idleMinutes ?? this.manager.cfg.idleMinutes; }
  get blocked(): string[] { return this.settings.blocked || []; }

  setSettings(patch: Partial<Record<keyof Settings, unknown>>) {
    const next: Record<string, unknown> = { ...this.settings, ...patch };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    this.settings = next as Settings;
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.changed();
  }

  info(): WorkspaceInfo {
    return {
      name: this.name, state: this.state, error: this.error,
      idleMinutes: this.idleMinutes, customIdle: this.settings.idleMinutes !== undefined,
      agents: [...this.agents].map(([name, a]) => ({ name, connections: a.connections, lastActive: a.lastActive, tabs: this.owners.count(name) })),
      blocked: this.blocked,
      viewers: this.leases.size,
      sleepsIn: this.state === 'awake' && !this.leases.size && this.idleMinutes > 0
        ? Math.max(0, Math.round((this.lastActive + this.idleMinutes * 60e3 - Date.now()) / 1000)) : null,
      memoryMB: this.state === 'awake' ? this.memoryMB : null,
      tabs: this.tabmap ? [...this.tabmap.urls.values()].filter(u => !/^(devtools|chrome-extension):/.test(u)).length : 0,
    };
  }

  changed() { this.manager.emit('change', this); }
  touch(agent?: string) {
    this.lastActive = Date.now();
    const a = agent && this.agents.get(agent);
    if (a) a.lastActive = this.lastActive;
  }

  log(kind: ActivityKind, agent: string | null, extra: { url?: string; detail?: string } = {}) {
    const item: Activity = { id: ++activitySeq, at: Date.now(), kind, agent, ...extra };
    this.activity.push(item);
    if (this.activity.length > ACTIVITY_KEEP) this.activity.splice(0, this.activity.length - ACTIVITY_KEEP);
    this.emit('activity', item);
  }

  agentJoin(name: string) {
    const a = this.agents.get(name);
    if (a) a.connections++;
    else { this.agents.set(name, { connections: 1, lastActive: Date.now() }); this.log('connect', name); }
    this.touch(); this.changed();
  }

  agentLeave(name: string) {
    const a = this.agents.get(name);
    if (a && --a.connections <= 0) { this.agents.delete(name); this.log('disconnect', name); }
    this.touch(); this.changed();
  }

  // close an agent's connections; with block, it can't reconnect until unblocked
  kick(name: string) { this.emit('kick', name); }
  block(name: string, on: boolean) {
    const set = new Set(this.blocked);
    on ? set.add(name) : set.delete(name);
    this.setSettings({ blocked: set.size ? [...set] : null });
    if (on) { this.kick(name); this.log('blocked', name); }
  }

  lease(token: object) { this.leases.add(token); this.touch(); this.changed(); }
  release(token: object) { if (this.leases.delete(token)) { this.touch(); this.changed(); } }

  // resolves with the running chrome; concurrent callers share one start
  wake(): Promise<Chrome> {
    if (this.state === 'awake' && this.chrome) return Promise.resolve(this.chrome);
    if (this.waking) return this.waking;
    this.waking = (async () => {
      if (this.sleeping) await this.sleeping;
      this.state = 'waking'; this.error = null; this.changed();
      try {
        this.owners.prepareRestore();
        const c = this.chrome = await chrome.launch({ profile: this.profile, cfg: this.manager.cfg });
        const tm = this.tabmap = new TabMap(c, this.owners, this.downloads.dir);
        tm.on('navigate', (_id: string, owner: string, url: string) => this.log('navigate', owner, { url }));
        tm.on('closed', (_id: string, owner: string, url?: string) => this.log('close', owner, { url }));
        tm.on('download', d => {
          this.downloads.begin(d);
          this.log('download', d.owner, { url: d.url, detail: d.name });
          this.emit('downloads');
        });
        tm.on('downloadProgress', p => { if (this.downloads.progress(p)) this.emit('downloads'); });
        await tm.start();
        setTimeout(() => this.owners.dropRestore(), 60e3);
        c.proc.once('exit', () => this.onExit());
        this.state = 'awake';
        this.touch();
        this.log('wake', null);
        this.manager.measureSoon();
        return c;
      } catch (e) {
        this.state = 'asleep'; this.error = (e as Error).message; this.chrome = null;
        throw e;
      } finally {
        this.waking = null; this.changed();
      }
    })();
    return this.waking;
  }

  // Chrome died on its own (crash, killed): report it and let the next user restart it
  private onExit() {
    if (this.state !== 'awake') return;
    this.tabmap?.stop();
    this.chrome = null; this.tabmap = null;
    this.state = 'asleep'; this.error = 'Chrome exited unexpectedly';
    this.emit('sleep');
    this.log('sleep', null, { detail: 'crashed' });
    this.changed();
  }

  sleep(): Promise<void> {
    if (this.state !== 'awake' || !this.chrome) return this.sleeping || Promise.resolve();
    const c = this.chrome;
    this.sleeping = (async () => {
      this.state = 'sleeping'; this.changed();
      this.emit('sleep'); // viewers and agent connections let go
      try {
        const list = await (await fetch(`${c.http}/json/list`)).json() as { id: string; type: string; url: string }[];
        this.owners.snapshot(list.filter(t => t.type === 'page').map(t => ({ id: t.id, url: t.url })));
      } catch {}
      this.tabmap?.stop();
      await c.stop();
      this.chrome = null; this.tabmap = null;
      this.state = 'asleep'; this.sleeping = null;
      this.log('sleep', null);
      this.changed();
    })();
    return this.sleeping;
  }

  idleCheck() {
    if (this.state !== 'awake' || this.leases.size || this.idleMinutes <= 0) return;
    if (Date.now() - this.lastActive > this.idleMinutes * 60e3) this.sleep();
  }
}

export class Manager extends EventEmitter {
  root: string;
  all = new Map<string, Workspace>();
  ready: Promise<unknown>;
  private timers: NodeJS.Timeout[];
  private measureT?: NodeJS.Timeout;

  constructor(public cfg: Config) {
    super();
    this.setMaxListeners(0);
    this.root = path.join(cfg.home, 'workspaces');
    fs.mkdirSync(this.root, { recursive: true });
    for (const d of fs.readdirSync(this.root)) if (WORKSPACE_NAME.test(d)) this.get(d);
    this.get('default');
    // browsers left running by a crashed previous run hold RAM; stop them
    this.ready = Promise.all([...this.all.values()].map(w => chrome.killStale(w.profile, path.join(w.dir, 'pids.json'))));
    this.timers = [
      setInterval(() => this.all.forEach(w => w.idleCheck()), 15e3),
      // keeps "sleeps in" countdowns and memory figures fresh in the viewer
      setInterval(() => { this.measure(); this.emit('tick'); }, 15e3),
    ];
  }

  static valid(name: string) { return WORKSPACE_NAME.test(name); }

  get(name: string, { create = true } = {}): Workspace | null {
    if (!WORKSPACE_NAME.test(name)) return null;
    if (!this.all.has(name)) {
      if (!create) return null;
      this.all.set(name, new Workspace(this, name));
      this.emit('change');
    }
    return this.all.get(name)!;
  }

  list(): WorkspaceInfo[] {
    return [...this.all.values()]
      .sort((a, b) => a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name))
      .map(w => w.info());
  }

  measure() {
    const awake = [...this.all.values()].filter(w => w.chrome);
    const mb = treeMemoryMB(awake.map(w => [w.chrome!.proc.pid, w.chrome!.xvfbPid]));
    awake.forEach((w, i) => { w.memoryMB = mb[i]; });
  }

  // memory right after a wake is still climbing; measure again shortly
  measureSoon() {
    clearTimeout(this.measureT);
    this.measureT = setTimeout(() => { this.measure(); this.emit('tick'); }, 4000);
  }

  async remove(name: string) {
    const w = this.all.get(name);
    if (!w || name === 'default') return false;
    await w.sleep();
    this.all.delete(name);
    fs.rmSync(w.dir, { recursive: true, force: true });
    this.emit('change');
    return true;
  }

  async shutdown() {
    this.timers.forEach(clearInterval);
    clearTimeout(this.measureT);
    await Promise.all([...this.all.values()].map(w => w.sleep()));
  }
}
