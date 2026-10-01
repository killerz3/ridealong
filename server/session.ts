// One connected viewer. It shows any tab of any workspace and forwards mouse
// and keyboard back. Two streaming modes:
//   jpeg  - CDP screencast, frames only when the page changes; paced by the
//           viewer's acks so a slow link drops frames instead of queueing them
//   video - H.264 of the workspace display via ffmpeg, decoded with WebCodecs
import WebSocket from 'ws';
import type { Config } from './config.js';
import type { Chrome } from './chrome.js';
import type { Manager, Workspace } from './workspaces.js';
import type { CdpMsg, TargetInfo } from './tabmap.js';
import { VideoCapture } from './video.js';
import type { Uploads } from './uploads.js';
import {
  FRAME_JPEG, FRAME_KEY, FRAME_DELTA, HEADER_BYTES,
  type Activity, type ClientMsg, type ServerMsg, type Stage, type StreamMode, type TabInfo,
} from '../shared/protocol.js';

function header(type: number, seq: number, w: number, h: number) {
  const b = Buffer.alloc(HEADER_BYTES);
  b.writeUInt8(type, 0); b.writeUInt32LE(seq, 4); b.writeFloatLE(w, 8); b.writeFloatLE(h, 12);
  return b;
}

const MODS = (m: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }) =>
  (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
const EDIT: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };
const HIDDEN_URL = /^(devtools|chrome-extension):\/\//;
const THUMB_W = 480;

type Result = Record<string, any>;

export class ViewerSession {
  private w: Workspace | null = null;
  private cdp: WebSocket | null = null;
  private session: string | null = null;
  private current: string | null = null;
  private visible = true;
  private mode: StreamMode = 'jpeg';
  private stage: Stage = { w: 1280, h: 800, dpr: 1, mobile: false };
  private targets = new Map<string, TargetInfo>(); // pages
  private id = 0;
  private waiters = new Map<number, (r: Result) => void>();
  private seq = 0;
  private sent = new Map<number, number>();
  private inflight = 0;
  private pendingAck: number | null = null;
  private rtt = 0; private bytes = 0; private frames = 0; private quality = 70;
  private video: VideoCapture | null = null;
  private closed = false;
  private chooser: number | null = null; // backendNodeId of a file input waiting for files
  private thumbsOn = false;
  private thumbT?: NodeJS.Timeout;
  private timers: NodeJS.Timeout[] = [];
  private restartT?: NodeJS.Timeout; private tabsT?: NodeJS.Timeout; private wsT?: NodeJS.Timeout; private dlT?: NodeJS.Timeout; private pageT?: NodeJS.Timeout;
  private ua?: string;
  private tabsSig = '';

  private onChange = () => this.sendWorkspaces();
  private onSleep = () => this.detach('asleep');
  private onTabsUpdate = () => this.sendTabsSoon();
  private onActivity = (item: Activity) => this.w && this.out({ t: 'activity', workspace: this.w.name, items: [item] });
  private onDownloads = () => { clearTimeout(this.dlT); this.dlT = setTimeout(() => this.sendDownloads(), 250); };

  constructor(private ws: WebSocket, private cfg: Config, private manager: Manager, private uploads: Uploads) {
    manager.on('change', this.onChange);
    manager.on('tick', this.onChange);
    this.timers.push(setInterval(() => this.stats(), 1000), setInterval(() => this.refreshTargets(), 2000));
    ws.on('message', (raw, binary) => {
      if (binary) return;
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)); } catch { return; }
      this.onMessage(m).catch(e => this.out({ t: 'toast', msg: e.message, kind: 'error' }));
    });
    ws.on('close', () => this.close());
    this.sendWorkspaces();
  }

  private out(m: ServerMsg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  private sendWorkspaces() {
    clearTimeout(this.wsT);
    this.wsT = setTimeout(() => this.out({ t: 'workspaces', list: this.manager.list(), current: this.w?.name ?? null }), 50);
  }

  private sendDownloads() { if (this.w) this.out({ t: 'downloads', workspace: this.w.name, items: this.w.downloads.items }); }

  // ---- workspace + chrome connection ----

  private async useWorkspace(name: string) {
    if (this.closed) return;
    const w = this.manager.get(name);
    if (!w) return this.out({ t: 'toast', msg: 'Workspace names use a-z, 0-9, - and _', kind: 'error' });
    if (this.w !== w) {
      this.detach();
      if (this.w) this.unsubscribe(this.w);
      this.w = w; this.current = null;
      w.on('sleep', this.onSleep);
      w.on('activity', this.onActivity);
      w.on('downloads', this.onDownloads);
      if (this.visible) w.lease(this);
      this.out({ t: 'activity', workspace: w.name, items: w.activity.slice(-100), reset: true });
      this.sendDownloads();
    }
    this.sendWorkspaces();
    if (w.state !== 'awake') this.out({ t: 'state', state: 'waking', workspace: w.name });
    let chrome: Chrome;
    try { chrome = await w.wake(); } catch (e) { return this.out({ t: 'state', state: 'error', workspace: w.name, error: (e as Error).message }); }
    if (this.closed || this.w !== w || this.cdp) return;
    await this.connect(chrome);
  }

  private unsubscribe(w: Workspace) {
    w.release(this);
    w.off('sleep', this.onSleep);
    w.off('activity', this.onActivity);
    w.off('downloads', this.onDownloads);
  }

  private async connect(chrome: Chrome) {
    const w = this.w!;
    const cdp = new WebSocket(await chrome.wsUrl(), { perMessageDeflate: false, maxPayload: 256 << 20 });
    await new Promise((ok, no) => { cdp.once('open', ok); cdp.once('error', no); });
    if (this.closed || this.w !== w || this.cdp) return cdp.close();
    this.cdp = cdp; this.id = 0; this.waiters = new Map(); this.targets.clear();
    cdp.on('message', raw => this.onCdp(JSON.parse(String(raw))));
    cdp.on('close', () => { if (this.cdp === cdp) this.detach('asleep'); });
    w.tabmap?.on('update', this.onTabsUpdate);
    await this.send('Target.setDiscoverTargets', { discover: true });
    this.out({ t: 'state', state: 'awake', workspace: w.name });
    this.sendTabs();
    // open something right away: your most recent tab, else any tab, else a new one
    const pages = this.pageList();
    const pick = pages.find(p => !p.owner) || pages[0];
    if (pick) await this.view(pick.id);
    else await this.newTab();
    if (this.thumbsOn) this.thumbLoop();
  }

  private detach(state?: 'asleep') {
    this.stopStream();
    clearTimeout(this.thumbT);
    this.w?.tabmap?.off('update', this.onTabsUpdate);
    if (this.cdp) { const c = this.cdp; this.cdp = null; c.close(); }
    this.session = null; this.current = null; this.chooser = null;
    this.targets.clear();
    for (const r of this.waiters.values()) r({});
    this.waiters = new Map();
    if (state && this.w) this.out({ t: 'state', state, workspace: this.w.name, error: this.w.error });
  }

  private send(method: string, params: object = {}, sessionId?: string | null): Promise<Result> {
    const cdp = this.cdp;
    if (!cdp || cdp.readyState !== 1) return Promise.resolve({});
    return new Promise(resolve => {
      const i = ++this.id; this.waiters.set(i, resolve);
      cdp.send(JSON.stringify({ id: i, method, params, sessionId: sessionId || undefined }));
    });
  }
  private onPage(method: string, params: object = {}) { return this.session ? this.send(method, params, this.session) : Promise.resolve({} as Result); }

  private onCdp(msg: CdpMsg) {
    if (msg.id) {
      const w = this.waiters.get(msg.id); this.waiters.delete(msg.id);
      return w?.(msg.result || { error: msg.error });
    }
    const p = msg.params || {};
    switch (msg.method) {
      case 'Target.targetCreated': case 'Target.targetInfoChanged':
        if (p.targetInfo.type === 'page') {
          this.targets.set(p.targetInfo.targetId, p.targetInfo);
          this.sendTabsSoon();
          if (p.targetInfo.targetId === this.current) this.sendPageSoon();
        }
        return;
      case 'Target.targetDestroyed':
        if (this.targets.delete(p.targetId)) this.sendTabsSoon();
        if (p.targetId === this.current) this.onCurrentGone();
        return;
    }
    if (!msg.sessionId || msg.sessionId !== this.session) return;
    switch (msg.method) {
      case 'Page.screencastFrame': return this.onJpeg(p);
      case 'Page.frameNavigated': if (!p.frame.parentId) this.sendPageSoon(); return;
      case 'Page.navigatedWithinDocument': return this.sendPageSoon();
      case 'Page.frameStartedLoading': if (p.frameId === this.current) this.out({ t: 'loading', on: true }); return;
      case 'Page.frameStoppedLoading': if (p.frameId === this.current) this.out({ t: 'loading', on: false }); return;
      case 'Page.javascriptDialogOpening': return this.out({ t: 'dialog', type: p.type, message: p.message, value: p.defaultPrompt || '' });
      case 'Page.javascriptDialogClosed': return this.out({ t: 'dialog', closed: true });
      case 'Page.fileChooserOpened':
        this.chooser = p.backendNodeId ?? null;
        return this.out({ t: 'filechooser', multiple: p.mode === 'selectMultiple' });
    }
  }

  private async onCurrentGone() {
    this.stopStream();
    if (this.current) this.targets.delete(this.current);
    this.session = null; this.current = null; this.chooser = null;
    if (!this.cdp) return;
    const list = this.pageList();
    const next = list.find(p => !p.owner) || list[0];
    if (next) await this.view(next.id); else this.out({ t: 'view', id: null });
  }

  private pageList(): TabInfo[] {
    const owners = this.w?.owners;
    return [...this.targets.values()]
      .filter(t => !HIDDEN_URL.test(t.url) && !t.subtype) // subtype: prerendered pages, not real tabs
      .map(t => ({ id: t.targetId, title: t.title, url: t.url, owner: owners?.get(t.targetId) || null }));
  }
  // Chrome reports a title change only with the next navigation event, so
  // titles are re-read every couple of seconds
  private async refreshTargets() {
    if (!this.cdp) return;
    const r = await this.send('Target.getTargets');
    if (!r.targetInfos) return;
    let changed = false;
    for (const t of r.targetInfos as TargetInfo[]) {
      const old = this.targets.get(t.targetId);
      if (t.type !== 'page' || !old || (old.title === t.title && old.url === t.url)) continue;
      this.targets.set(t.targetId, t);
      changed = true;
      if (t.targetId === this.current) this.sendPageSoon();
    }
    // also picks up ownership that was settled after the tab first appeared
    this.sendTabs(!changed);
  }

  private sendTabsSoon() { clearTimeout(this.tabsT); this.tabsT = setTimeout(() => this.sendTabs(), 60); }
  private sendTabs(onlyIfChanged = false) {
    if (!this.cdp) return;
    const tabs = this.pageList();
    const sig = JSON.stringify([this.current, tabs]);
    if (onlyIfChanged && sig === this.tabsSig) return;
    this.tabsSig = sig;
    this.out({ t: 'tabs', current: this.current, tabs });
  }

  private sendPageSoon() { clearTimeout(this.pageT); this.pageT = setTimeout(() => this.sendPage(), 40); }
  private async sendPage() {
    if (!this.session || !this.current) return;
    const h = await this.onPage('Page.getNavigationHistory');
    const t = this.targets.get(this.current);
    if (!h.entries) return;
    const e = h.entries[h.currentIndex] || {};
    this.out({ t: 'page', url: e.url || t?.url || '', title: t?.title || e.title || '', canBack: h.currentIndex > 0, canFwd: h.currentIndex < h.entries.length - 1 });
  }

  // ---- viewing a tab ----

  private async view(targetId: string) {
    if (!this.cdp) return;
    this.stopStream();
    if (this.session) { this.send('Target.detachFromTarget', { sessionId: this.session }); this.session = null; }
    this.current = targetId; this.chooser = null;
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true });
    if (!r.sessionId) return this.onCurrentGone();
    this.session = r.sessionId;
    this.out({ t: 'view', id: targetId });
    await this.send('Target.activateTarget', { targetId });
    await this.onPage('Page.enable');
    // file inputs ask you for files instead of opening a dialog nobody can see
    await this.onPage('Page.setInterceptFileChooserDialog', { enabled: true });
    this.sendTabs();
    this.sendPage();
    await this.startStream();
  }

  private async newTab(url = 'about:blank') {
    const r = await this.send('Target.createTarget', { url, newWindow: true });
    if (r.targetId) await this.view(r.targetId);
  }

  // Your own tabs render at the size of your viewer (phone-width on a phone);
  // agents' tabs keep their own size so watching them doesn't change the page.
  private mine() { return !!this.w && !this.w.owners.get(this.current || undefined); }

  private async startStream() {
    if (!this.session) return;
    this.inflight = 0; this.pendingAck = null; this.sent.clear();
    if (this.mode === 'video') {
      await this.onPage('Emulation.clearDeviceMetricsOverride');
      return this.startVideo();
    }
    const dpr = Math.min(this.stage.dpr || 1, 2);
    if (this.mine()) {
      await this.onPage('Emulation.setDeviceMetricsOverride', {
        width: Math.max(200, this.stage.w), height: Math.max(200, this.stage.h),
        deviceScaleFactor: this.stage.mobile ? dpr : 1, mobile: !!this.stage.mobile,
      });
      // on a phone, look like a phone so sites send their mobile layout
      await this.onPage('Emulation.setTouchEmulationEnabled', { enabled: !!this.stage.mobile, maxTouchPoints: 5 });
      await this.onPage('Emulation.setUserAgentOverride', { userAgent: this.stage.mobile ? await this.mobileUA() : '' });
    } else await this.onPage('Emulation.clearDeviceMetricsOverride');
    await this.onPage('Page.startScreencast', {
      format: 'jpeg', quality: this.quality,
      maxWidth: Math.round(this.stage.w * dpr), maxHeight: Math.round(this.stage.h * dpr),
    });
  }

  private async mobileUA() {
    if (!this.ua) {
      const v = await this.send('Browser.getVersion');
      const ver = ((v.userAgent || '').match(/Chrome\/([\d.]+)/) || [, '140.0.0.0'])[1].replace(/\.\d+\.\d+\.\d+$/, '.0.0.0');
      this.ua = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Mobile Safari/537.36`;
    }
    return this.ua;
  }

  private stopStream() {
    if (this.video) { this.video.stop(); this.video = null; }
    if (this.session) this.onPage('Page.stopScreencast');
  }

  private restartStreamSoon() {
    clearTimeout(this.restartT);
    this.restartT = setTimeout(() => { this.stopStream(); this.startStream(); }, 250);
  }

  // Frames are acked to Chrome only once the viewer has them (2 in flight),
  // so a slow link lowers the frame rate instead of building a backlog.
  private onJpeg(p: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) {
    this.push(FRAME_JPEG, Buffer.from(p.data, 'base64'), p.metadata.deviceWidth, p.metadata.deviceHeight);
    if (this.inflight < 2) this.send('Page.screencastFrameAck', { sessionId: p.sessionId }, this.session);
    else this.pendingAck = p.sessionId;
  }

  private push(type: number, data: Buffer, w: number, h: number) {
    const seq = ++this.seq;
    this.sent.set(seq, Date.now());
    this.inflight++;
    this.bytes += data.length; this.frames++;
    this.ws.send(Buffer.concat([header(type, seq, w, h), data]));
  }

  private onAck(seq: number) {
    const t = this.sent.get(seq);
    if (t) {
      this.rtt = this.rtt ? this.rtt * 0.8 + (Date.now() - t) * 0.2 : Date.now() - t;
      for (const k of this.sent.keys()) { if (k > seq) break; this.sent.delete(k); }
    }
    this.inflight = this.sent.size;
    if (this.pendingAck !== null && this.inflight < 2) {
      this.send('Page.screencastFrameAck', { sessionId: this.pendingAck }, this.session);
      this.pendingAck = null;
    }
  }

  private async startVideo() {
    const targetId = this.current, w = this.w;
    const chrome = w?.chrome;
    if (!targetId || !chrome) return;
    // put the tab's window at the top-left of the display, on top, so its page
    // can be captured; your own tabs are also sized to your viewer
    const measure = () => this.onPage('Runtime.evaluate', {
      expression: 'JSON.stringify([screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight])', returnByValue: true,
    });
    const win = await this.send('Browser.getWindowForTarget', { targetId });
    if (win.windowId) {
      const b = win.bounds || {};
      await this.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      let size = { width: Math.min(b.width || chrome.width, chrome.width), height: Math.min(b.height || chrome.height, chrome.height) };
      if (this.mine()) {
        const m = await measure();
        const [, , ow, oh, iw, ih] = m.result ? JSON.parse(m.result.value) : [0, 0, 0, 0, 0, 0];
        size = { width: Math.min(chrome.width, Math.max(400, this.stage.w + (ow - iw))), height: Math.min(chrome.height, Math.max(300, this.stage.h + (oh - ih))) };
      }
      await this.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: 0, top: 0, ...size } });
    }
    await this.send('Target.activateTarget', { targetId });
    await new Promise(r => setTimeout(r, 150));
    const ev = await measure();
    if (this.current !== targetId || this.mode !== 'video' || !ev.result) return;
    const [sx, sy, ow, oh, iw, ih] = JSON.parse(ev.result.value);
    const x = Math.max(0, sx + Math.round((ow - iw) / 2)), y = Math.max(0, sy + (oh - ih));
    const crop = { x, y, w: Math.min(iw, chrome.width - x), h: Math.min(ih, chrome.height - y) };
    const dpr = Math.min(this.stage.dpr || 1, 2);
    const scale = Math.min(1, (this.stage.w * dpr) / crop.w, (this.stage.h * dpr) / crop.h);
    const v = this.video = new VideoCapture({
      display: chrome.display, crop, fps: this.cfg.fps, out: { w: Math.round(crop.w * scale), h: Math.round(crop.h * scale) },
    }).start();
    let waitKey = true;
    v.on('frame', (au: Buffer, key: boolean) => {
      if (this.video !== v) return;
      // more than ~half a second behind: skip to the next keyframe
      if (this.inflight > this.cfg.fps / 2 || this.ws.bufferedAmount > 4 << 20) waitKey = true;
      if (waitKey && !key) return;
      waitKey = false;
      this.push(key ? FRAME_KEY : FRAME_DELTA, au, crop.w, crop.h);
    });
    v.on('error', (e: Error) => {
      if (this.video !== v) return;
      this.video = null;
      this.mode = 'jpeg';
      this.out({ t: 'mode', mode: 'jpeg', msg: 'Video mode stopped: ' + e.message.split('\n')[0] });
      this.startStream();
    });
  }

  // adapt JPEG quality to the link: slow acks -> smaller frames
  private stats() {
    if (!this.session) return;
    const kbps = Math.round(this.bytes * 8 / 1000);
    this.out({ t: 'stats', fps: this.frames, kbps, rtt: Math.round(this.rtt), quality: this.mode === 'jpeg' ? this.quality : null, mode: this.mode });
    const busy = this.frames > 0;
    this.bytes = 0; this.frames = 0;
    if (this.mode !== 'jpeg' || !busy) return;
    const q = this.quality;
    if (this.rtt > 250) this.quality = Math.max(35, q - 15);
    else if (this.rtt < 90) this.quality = Math.min(80, q + 5);
    if (this.quality !== q) this.restartStreamSoon();
  }

  // ---- overview thumbnails: a small screenshot of every tab, every few seconds ----

  private async thumbLoop() {
    clearTimeout(this.thumbT);
    if (!this.thumbsOn || !this.cdp || this.closed) return;
    for (const tab of this.pageList()) {
      if (!this.thumbsOn || !this.cdp) return;
      const data = await this.thumb(tab.id);
      if (data) this.out({ t: 'thumb', id: tab.id, data });
    }
    this.thumbT = setTimeout(() => this.thumbLoop(), 3000);
  }

  private async thumb(targetId: string): Promise<string | null> {
    const own = targetId === this.current && this.session;
    const sid = own ? this.session : (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    if (!sid) return null;
    try {
      const m = await this.timeout(this.send('Page.getLayoutMetrics', {}, sid), 2000);
      const vp = m?.cssVisualViewport;
      if (!vp) return null;
      const shot = await this.timeout(this.send('Page.captureScreenshot', {
        format: 'jpeg', quality: 60,
        clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: Math.min(1, THUMB_W / vp.clientWidth) },
      }, sid), 3000);
      return shot?.data || null;
    } finally {
      if (!own) this.send('Target.detachFromTarget', { sessionId: sid });
    }
  }

  private timeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([p, new Promise<null>(r => setTimeout(() => r(null), ms))]);
  }

  private async screenshot() {
    const t = this.current ? this.targets.get(this.current) : undefined;
    const shot = await this.onPage('Page.captureScreenshot', { format: 'png' });
    if (!shot.data) return this.out({ t: 'toast', msg: 'Nothing to capture yet', kind: 'error' });
    let host = 'page';
    try { host = new URL(t ? t.url : '').hostname || 'page'; } catch {}
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    this.out({ t: 'screenshot', data: shot.data, name: `${host}-${stamp}.png` });
  }

  // ---- messages from the page ----

  private async onMessage(m: ClientMsg) {
    switch (m.t) {
      case 'hello':
        this.stage = { w: m.w || 1280, h: m.h || 800, dpr: m.dpr || 1, mobile: !!m.mobile };
        if (m.mode === 'video' || m.mode === 'jpeg') this.mode = m.mode;
        this.visible = m.visible !== false;
        return this.useWorkspace(m.workspace && this.manager.get(m.workspace, { create: false }) ? m.workspace : 'default');
      case 'workspace': return this.useWorkspace(String(m.name || '').trim().toLowerCase());
      case 'wake': return this.useWorkspace(this.w ? this.w.name : 'default');
      case 'sleep': return this.manager.get(m.name, { create: false })?.sleep();
      case 'delete': {
        if (m.name === 'default') return;
        if (this.w?.name === m.name) await this.useWorkspace('default');
        await this.manager.remove(m.name);
        return;
      }
      case 'idle':
        return this.manager.get(m.name, { create: false })
          ?.setSettings({ idleMinutes: m.minutes === null ? null : Math.max(0, Math.min(1440, +m.minutes || 0)) });
      case 'visible':
        if (this.closed) return;
        this.visible = !!m.on;
        if (this.w) this.visible ? this.w.lease(this) : this.w.release(this);
        return;
      case 'size':
        this.stage = { w: m.w, h: m.h, dpr: m.dpr || 1, mobile: !!m.mobile };
        return this.restartStreamSoon();
      case 'mode':
        if (m.mode !== this.mode && (m.mode === 'video' || m.mode === 'jpeg')) { this.mode = m.mode; this.stopStream(); await this.startStream(); }
        return;
      case 'ack': return this.onAck(m.seq);
      case 'keyframe': if (this.mode === 'video') this.restartStreamSoon(); return;
      case 'ping': return this.out({ t: 'pong', ts: m.ts });
      case 'thumbs':
        this.thumbsOn = !!m.on;
        if (this.thumbsOn) this.thumbLoop(); else clearTimeout(this.thumbT);
        return;
      case 'agent': {
        const w = this.w;
        if (!w) return;
        if (m.action === 'disconnect') return w.kick(m.name);
        if (m.action === 'block' || m.action === 'unblock') return w.block(m.name, m.action === 'block');
        if (m.action === 'closeTabs') {
          for (const t of this.pageList()) if (t.owner === m.name) await this.send('Target.closeTarget', { targetId: t.id });
        }
        return;
      }
    }
    this.w?.touch();
    if (!this.cdp) return;
    switch (m.t) {
      case 'view': return this.view(m.id);
      case 'new': return this.newTab(m.url ? this.toUrl(m.url) : undefined);
      case 'close': await this.send('Target.closeTarget', { targetId: m.id }); return;
      case 'nav': {
        const url = this.toUrl(m.url);
        if (!url) return;
        if (!this.session) return this.newTab(url);
        await this.onPage('Page.navigate', { url });
        return;
      }
      case 'back': case 'fwd': {
        const h = await this.onPage('Page.getNavigationHistory');
        const e = h.entries?.[h.currentIndex + (m.t === 'back' ? -1 : 1)];
        if (e) await this.onPage('Page.navigateToHistoryEntry', { entryId: e.id });
        return;
      }
      case 'reload': await this.onPage('Page.reload'); return;
      case 'stop': await this.onPage('Page.stopLoading'); return;
      case 'dialog': await this.onPage('Page.handleJavaScriptDialog', { accept: !!m.accept, promptText: m.text }); return;
      case 'files': {
        const node = this.chooser;
        this.chooser = null;
        const files = m.ids.map(id => this.uploads.path(id, this.w!.name)).filter((p): p is string => !!p);
        if (node && files.length) await this.onPage('DOM.setFileInputFiles', { files, backendNodeId: node });
        return;
      }
      case 'screenshot': return this.screenshot();
      case 'mouse':
        await this.onPage('Input.dispatchMouseEvent', {
          type: m.type, x: m.x, y: m.y, button: m.button || 'none', buttons: m.buttons || 0, clickCount: m.clickCount || 0,
          deltaX: m.dx || 0, deltaY: m.dy || 0, modifiers: MODS(m),
        });
        return;
      case 'key': {
        const cmd = (m.ctrl || m.meta) && EDIT[String(m.key).toLowerCase()];
        if (m.type === 'keyDown' && cmd === 'copy') {
          const r = await this.onPage('Runtime.evaluate', { expression: 'String(getSelection())' });
          if (r.result?.value) this.out({ t: 'clip', text: r.result.value });
        }
        const text = !(m.ctrl || m.meta || m.alt) ? (m.key === 'Enter' ? '\r' : m.key.length === 1 ? m.key : '') : '';
        await this.onPage('Input.dispatchKeyEvent', {
          type: m.type === 'keyUp' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
          key: m.key, code: m.code, text: m.type === 'keyUp' ? undefined : text || undefined,
          windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: MODS(m),
          commands: m.type === 'keyDown' && cmd && cmd !== 'copy' && cmd !== 'paste' ? [cmd] : undefined,
        });
        return;
      }
      case 'text': await this.onPage('Input.insertText', { text: String(m.text) }); return;
    }
  }

  // what you typed in the address bar -> a URL (search when it isn't one)
  private toUrl(input: string) {
    const s = String(input).trim();
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
    if (/^[^\s]+\.[^\s]+$|^localhost(:\d+)?(\/|$)|^\d+\.\d+\.\d+\.\d+(:\d+)?(\/|$)/.test(s)) return (/^(localhost|\d)/.test(s) ? 'http://' : 'https://') + s;
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
  }

  private close() {
    this.closed = true;
    this.timers.forEach(clearInterval);
    for (const t of [this.restartT, this.tabsT, this.wsT, this.dlT, this.pageT, this.thumbT]) clearTimeout(t);
    this.manager.off('change', this.onChange); this.manager.off('tick', this.onChange);
    this.detach();
    if (this.w) this.unsubscribe(this.w);
  }
}
