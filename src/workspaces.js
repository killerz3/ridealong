// A workspace is its own Chrome profile (own logins) running in its own
// Chrome + virtual display. It starts when someone needs it and is stopped
// after idleMinutes without a viewer or agent activity, so idle RAM is ~0.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const chrome = require('./chrome');
const Owners = require('./owners');
const TabMap = require('./tabmap');

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

class Workspace extends EventEmitter {
  constructor(manager, name) {
    super();
    this.setMaxListeners(0);
    this.manager = manager;
    this.name = name;
    this.dir = path.join(manager.root, name);
    this.profile = path.join(this.dir, 'profile');
    fs.mkdirSync(this.dir, { recursive: true });
    this.owners = new Owners(path.join(this.dir, 'owners.json'));
    this.settingsFile = path.join(this.dir, 'settings.json');
    try { this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { this.settings = {}; }
    this.state = 'asleep'; // asleep | waking | awake | sleeping
    this.chrome = null;
    this.tabmap = null;
    this.leases = new Set();  // viewers looking at this workspace
    this.agents = new Map();  // agent name -> open connections
    this.lastActive = Date.now();
    this.error = null;
  }

  get idleMinutes() {
    return this.settings.idleMinutes ?? this.manager.cfg.idleMinutes;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    for (const k of Object.keys(this.settings)) if (this.settings[k] === null) delete this.settings[k];
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.changed();
  }

  info() {
    return {
      name: this.name, state: this.state, error: this.error,
      idleMinutes: this.idleMinutes, customIdle: this.settings.idleMinutes !== undefined,
      agents: [...this.agents.keys()], viewers: this.leases.size,
      sleepsIn: this.state === 'awake' && !this.leases.size && this.idleMinutes > 0
        ? Math.max(0, Math.round((this.lastActive + this.idleMinutes * 60e3 - Date.now()) / 1000)) : null,
    };
  }

  changed() { this.manager.emit('change', this); }
  touch() { this.lastActive = Date.now(); }

  agentJoin(name) { this.agents.set(name, (this.agents.get(name) || 0) + 1); this.touch(); this.changed(); }
  agentLeave(name) {
    const n = (this.agents.get(name) || 1) - 1;
    n ? this.agents.set(name, n) : this.agents.delete(name);
    this.touch(); this.changed();
  }

  lease(token) { this.leases.add(token); this.touch(); this.changed(); }
  release(token) { if (this.leases.delete(token)) { this.touch(); this.changed(); } }

  // resolves with the running chrome; concurrent callers share one start
  wake() {
    if (this.state === 'awake') return Promise.resolve(this.chrome);
    if (this.waking) return this.waking;
    this.waking = (async () => {
      if (this.sleeping) await this.sleeping;
      this.state = 'waking'; this.error = null; this.changed();
      try {
        this.owners.prepareRestore();
        this.chrome = await chrome.launch({ profile: this.profile, cfg: this.manager.cfg });
        this.tabmap = new TabMap(this.chrome, this.owners);
        await this.tabmap.start();
        setTimeout(() => this.owners.dropRestore(), 60e3);
        this.chrome.proc.once('exit', () => this.onExit());
        this.state = 'awake';
        this.touch();
        return this.chrome;
      } catch (e) {
        this.state = 'asleep'; this.error = e.message; this.chrome = null;
        throw e;
      } finally {
        this.waking = null; this.changed();
      }
    })();
    return this.waking;
  }

  // Chrome died on its own (crash, killed): report it and let the next user restart it
  onExit() {
    if (this.state !== 'awake') return;
    this.tabmap.stop();
    this.chrome = null; this.tabmap = null;
    this.state = 'asleep'; this.error = 'Chrome exited unexpectedly';
    this.emit('sleep');
    this.changed();
  }

  sleep() {
    if (this.state !== 'awake') return this.sleeping || Promise.resolve();
    this.sleeping = (async () => {
      this.state = 'sleeping'; this.changed();
      this.emit('sleep'); // viewers and agent connections let go
      try {
        const list = await (await fetch(`${this.chrome.http}/json/list`)).json();
        this.owners.snapshot(list.filter(t => t.type === 'page').map(t => ({ id: t.id, url: t.url })));
      } catch {}
      this.tabmap.stop();
      await this.chrome.stop();
      this.chrome = null; this.tabmap = null;
      this.state = 'asleep'; this.sleeping = null; this.changed();
    })();
    return this.sleeping;
  }

  idleCheck() {
    if (this.state !== 'awake' || this.leases.size || this.idleMinutes <= 0) return;
    if (Date.now() - this.lastActive > this.idleMinutes * 60e3) this.sleep();
  }
}

class Manager extends EventEmitter {
  constructor(cfg) {
    super();
    this.setMaxListeners(0);
    this.cfg = cfg;
    this.root = path.join(cfg.home, 'workspaces');
    fs.mkdirSync(this.root, { recursive: true });
    this.all = new Map();
    for (const d of fs.readdirSync(this.root)) if (NAME.test(d)) this.get(d);
    this.get('default');
    // browsers left running by a crashed previous run hold RAM; stop them
    this.ready = Promise.all([...this.all.values()].map(w => chrome.killStale(w.profile, path.join(w.dir, 'pids.json'))));
    this.timer = setInterval(() => this.all.forEach(w => w.idleCheck()), 15e3);
    // tick so "sleeps in" countdowns stay fresh in the viewer
    this.tick = setInterval(() => this.emit('tick'), 30e3);
  }

  static valid(name) { return NAME.test(name); }

  get(name, { create = true } = {}) {
    if (!NAME.test(name)) return null;
    if (!this.all.has(name)) {
      if (!create) return null;
      this.all.set(name, new Workspace(this, name));
      this.emit('change');
    }
    return this.all.get(name);
  }

  list() {
    return [...this.all.values()].sort((a, b) => a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)).map(w => w.info());
  }

  async remove(name) {
    const w = this.all.get(name);
    if (!w || name === 'default') return false;
    await w.sleep();
    this.all.delete(name);
    fs.rmSync(w.dir, { recursive: true, force: true });
    this.emit('change');
    return true;
  }

  async shutdown() {
    clearInterval(this.timer); clearInterval(this.tick);
    await Promise.all([...this.all.values()].map(w => w.sleep()));
  }
}

module.exports = { Manager, Workspace };
