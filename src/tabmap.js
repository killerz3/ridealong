// Recent Chrome exposes every tab twice: a "tab" target and the "page" inside
// it, with different ids. Agents (puppeteer) see tabs, ownership is recorded on
// pages, so each workspace keeps a live tab -> page map on a side connection.
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class TabMap extends EventEmitter {
  constructor(chrome, owners) {
    super();
    this.setMaxListeners(0);
    this.chrome = chrome;
    this.owners = owners;
    this.tabToPage = new Map();
    this.seen = new Map(); // tabId -> first time it attached
    this.stopped = false;
  }

  start() {
    // the first attach is part of waking up, so callers can wait for it
    return new Promise(resolve => this.connect(resolve));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.ws) this.ws.close();
  }

  async connect(ready = () => {}) {
    if (this.stopped) return ready();
    let id = 0;
    const tabSessions = new Map(); // sessionId -> tabId
    const retry = () => { if (!this.stopped) this.retry = setTimeout(() => this.connect(ready), 1000); };
    let ws;
    try { ws = this.ws = new WebSocket(await this.chrome.wsUrl(), { perMessageDeflate: false }); } catch { return retry(); }
    const send = (method, params, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
    ws.on('open', () => {
      send('Target.setDiscoverTargets', { discover: true });
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'tab' }] });
    });
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      const p = msg.params || {};
      if (msg.id === 2) ready();
      if (msg.method === 'Target.attachedToTarget') {
        const t = p.targetInfo;
        if (t.type === 'tab' && !msg.sessionId) {
          tabSessions.set(p.sessionId, t.targetId);
          this.seen.set(t.targetId, Date.now());
          send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'page' }] }, p.sessionId);
        } else if (t.type === 'page' && tabSessions.has(msg.sessionId)) {
          // a popup inherits its opener's owner
          if (!this.owners.get(t.targetId) && t.openerId && this.owners.get(t.openerId)) this.owners.set(t.targetId, this.owners.get(t.openerId));
          this.owners.claim(t.targetId, t.url);
          this.owners.noteUrl(t.targetId, t.url);
          this.tabToPage.set(tabSessions.get(msg.sessionId), t.targetId);
          this.emit('update');
        }
      } else if ((msg.method === 'Target.targetInfoChanged' || msg.method === 'Target.targetCreated') && p.targetInfo.type === 'page') {
        this.owners.claim(p.targetInfo.targetId, p.targetInfo.url);
        this.owners.noteUrl(p.targetInfo.targetId, p.targetInfo.url);
      } else if (msg.method === 'Target.targetDestroyed') {
        if (this.owners.get(p.targetId)) this.owners.del(p.targetId);
      } else if (msg.method === 'Target.detachedFromTarget' && tabSessions.has(p.sessionId)) {
        const tab = tabSessions.get(p.sessionId);
        this.tabToPage.delete(tab);
        this.seen.delete(tab);
        tabSessions.delete(p.sessionId);
      }
    });
    ws.on('close', retry);
    ws.on('error', () => {});
  }

  // owner of a page or tab target
  ownerOf(info) {
    return this.owners.get(info.type === 'tab' ? this.tabToPage.get(info.targetId) : info.targetId);
  }
}

module.exports = TabMap;
