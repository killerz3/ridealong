// Recent Chrome exposes every tab twice: a "tab" target and the "page" inside
// it, with different ids. Agents (puppeteer) see tabs, ownership is recorded on
// pages, so each workspace keeps a live tab -> page map on a side connection.
// The same connection reports navigation and downloads for the activity feed.
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { Chrome } from './chrome.js';
import type { Owners } from './owners.js';

export interface TargetInfo { targetId: string; type: string; url: string; title: string; openerId?: string; subtype?: string }
export interface CdpMsg { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string }

export class TabMap extends EventEmitter {
  tabToPage = new Map<string, string>();
  seen = new Map<string, number>(); // tabId -> first time it attached
  urls = new Map<string, string>(); // pageId -> last URL (every open page), to report navigations once
  private ws?: WebSocket;
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(private chrome: Chrome, private owners: Owners, private downloadDir: string) {
    super();
    this.setMaxListeners(0);
  }

  // the first attach is part of waking up, so callers can wait for it
  start(): Promise<void> { return new Promise(resolve => this.connect(resolve)); }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.ws?.close();
  }

  private async connect(ready: () => void = () => {}) {
    if (this.stopped) return ready();
    let id = 0;
    const tabSessions = new Map<string, string>(); // sessionId -> tabId
    const retry = () => { if (!this.stopped) this.retry = setTimeout(() => this.connect(ready), 1000); };
    let ws: WebSocket;
    try { ws = this.ws = new WebSocket(await this.chrome.wsUrl(), { perMessageDeflate: false }); } catch { return retry(); }
    const send = (method: string, params: object, sessionId?: string) => ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
    ws.on('open', () => {
      send('Target.setDiscoverTargets', { discover: true });
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'tab' }] });
      // downloads land in the workspace folder, so the viewer can hand them to you
      send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.downloadDir, eventsEnabled: true });
    });
    ws.on('message', raw => {
      const msg: CdpMsg = JSON.parse(String(raw));
      const p = msg.params || {};
      if (msg.id === 2) ready();
      switch (msg.method) {
        case 'Target.attachedToTarget': {
          const t: TargetInfo = p.targetInfo;
          // Chrome holds a window.open popup paused until every auto-attached
          // client lets it run, even when it reports waitingForDebugger: false.
          // Without this, "Continue with Google" on X hangs on a blank popup
          // and the opener shows "Debugger paused in another tab".
          send('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
          if (t.type === 'tab' && !msg.sessionId) {
            tabSessions.set(p.sessionId, t.targetId);
            this.seen.set(t.targetId, Date.now());
            send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'page' }] }, p.sessionId);
          } else if (t.type === 'page' && msg.sessionId && tabSessions.has(msg.sessionId)) {
            // a popup inherits its opener's owner
            if (!this.owners.get(t.targetId) && t.openerId && this.owners.get(t.openerId)) this.owners.set(t.targetId, this.owners.get(t.openerId)!);
            this.owners.claim(t.targetId, t.url);
            this.page(t);
            this.tabToPage.set(tabSessions.get(msg.sessionId)!, t.targetId);
            this.emit('update');
          }
          break;
        }
        case 'Target.targetInfoChanged': case 'Target.targetCreated':
          if (p.targetInfo.type === 'page' && !p.targetInfo.subtype) {
            this.owners.claim(p.targetInfo.targetId, p.targetInfo.url);
            this.page(p.targetInfo);
          }
          break;
        case 'Target.targetDestroyed': {
          const owner = this.owners.get(p.targetId);
          if (owner) { this.owners.del(p.targetId); this.emit('closed', p.targetId, owner, this.urls.get(p.targetId)); }
          this.urls.delete(p.targetId);
          break;
        }
        case 'Target.detachedFromTarget':
          if (tabSessions.has(p.sessionId)) {
            const tab = tabSessions.get(p.sessionId)!;
            this.tabToPage.delete(tab);
            this.seen.delete(tab);
            tabSessions.delete(p.sessionId);
          }
          break;
        case 'Browser.downloadWillBegin':
          this.emit('download', { id: p.guid, name: p.suggestedFilename, url: p.url, owner: this.owners.get(p.frameId) || null });
          break;
        case 'Browser.downloadProgress':
          this.emit('downloadProgress', { id: p.guid, state: p.state, received: p.receivedBytes, total: p.totalBytes });
          break;
      }
    });
    ws.on('close', retry);
    ws.on('error', () => {});
  }

  private page(t: TargetInfo) {
    this.owners.noteUrl(t.targetId, t.url);
    const before = this.urls.get(t.targetId);
    if (before === t.url) return;
    this.urls.set(t.targetId, t.url);
    const owner = this.owners.get(t.targetId);
    if (owner && before !== undefined && t.url && t.url !== 'about:blank') this.emit('navigate', t.targetId, owner, t.url);
  }

  // owner of a page or tab target
  ownerOf(info: { type: string; targetId: string }) {
    return this.owners.get(info.type === 'tab' ? this.tabToPage.get(info.targetId) : info.targetId);
  }
}
