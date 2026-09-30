// Web viewer: shows any tab of any workspace in your browser and forwards
// mouse/keyboard back. Two streaming modes:
//   jpeg  - CDP screencast, frames only when the page changes; paced by the
//           viewer's acks so a slow link drops frames instead of queueing them
//   video - H.264 of the workspace display via ffmpeg, decoded with WebCodecs
// Password-gated; meant to sit behind a tunnel or reverse proxy.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { VideoCapture } = require('./video');
const pkg = require('../package.json');

const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2f6fe4" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="3" fill="#fff"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/></svg>';
const FRAME_JPEG = 1, FRAME_KEY = 2, FRAME_DELTA = 3;

function header(type, seq, w, h) {
  const b = Buffer.alloc(16);
  b.writeUInt8(type, 0); b.writeUInt32LE(seq, 4); b.writeFloatLE(w, 8); b.writeFloatLE(h, 12);
  return b;
}

function start({ cfg, manager }) {
  const secret = crypto.createHash('sha256').update('tabkennel:' + cfg.password).digest('hex');
  const authed = req => (req.headers.cookie || '').split(/;\s*/).includes('tk=' + secret);
  const page = name => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
  const boot = JSON.stringify({ agentPort: cfg.agentPort, version: pkg.version, idleMinutes: cfg.idleMinutes });
  const secure = req => req.headers['x-forwarded-proto'] === 'https' || /"https"/.test(req.headers['cf-visitor'] || '');
  const send = (res, status, type, body, extra = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/login') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
      return req.on('end', () => {
        const given = Buffer.from(String(new URLSearchParams(body).get('password') || ''));
        const want = Buffer.from(String(cfg.password));
        const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
        // failed guesses are slow on purpose
        setTimeout(() => send(res, 303, 'text/plain', '', {
          location: ok ? '/' : '/?wrong',
          ...(ok && { 'set-cookie': `tk=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure(req) ? '; Secure' : ''}` }),
        }), ok ? 0 : 800);
      });
    }
    if (url === '/logout') return send(res, 303, 'text/plain', '', { location: '/', 'set-cookie': 'tk=; Path=/; Max-Age=0' });
    if (url === '/healthz') return send(res, 200, 'text/plain', 'ok');
    if (url === '/favicon.ico' || url === '/favicon.svg') return send(res, 200, 'image/svg+xml', FAVICON, { 'cache-control': 'max-age=86400' });
    if (!authed(req)) return send(res, url === '/' ? 200 : 401, 'text/html; charset=utf-8', page('login.html'));
    send(res, 200, 'text/html; charset=utf-8', page('index.html').replace('/*BOOT*/{}', boot));
  });

  const sameOrigin = req => {
    try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const wss = new WebSocket.Server({ server, maxPayload: 1 << 20, verifyClient: ({ req }) => authed(req) && sameOrigin(req) });
  wss.on('connection', ws => new ViewerSession(ws, cfg, manager));

  return new Promise((ok, fail) => { server.once('error', fail); server.listen(cfg.viewerPort, cfg.bind, () => ok(server)); });
}

class ViewerSession {
  constructor(ws, cfg, manager) {
    this.ws = ws; this.cfg = cfg; this.manager = manager;
    this.w = null; this.cdp = null; this.session = null; this.current = null;
    this.visible = true; this.mode = 'jpeg';
    this.stage = { w: 1280, h: 800 };
    this.targets = new Map(); // targetId -> targetInfo (pages)
    this.seq = 0; this.sent = new Map(); this.inflight = 0; this.pendingAck = null;
    this.rtt = 0; this.bytes = 0; this.frames = 0; this.quality = 70;
    this.video = null;

    this.onChange = () => this.sendWorkspaces();
    this.onSleep = () => this.detach('asleep');
    manager.on('change', this.onChange);
    manager.on('tick', this.onChange);
    this.statsTimer = setInterval(() => this.stats(), 1000);
    this.tabsTimer = setInterval(() => this.sendTabs(), 2000);

    ws.on('message', (raw, binary) => { if (!binary) this.onMessage(JSON.parse(raw)).catch(e => this.out({ t: 'toast', msg: e.message })); });
    ws.on('close', () => this.close());
    this.sendWorkspaces();
  }

  out(m) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }

  sendWorkspaces() {
    clearTimeout(this.wsTimer);
    this.wsTimer = setTimeout(() => this.out({ t: 'workspaces', list: this.manager.list(), current: this.w && this.w.name }), 50);
  }

  // ---- workspace + chrome connection ----

  async useWorkspace(name) {
    if (this.closed) return;
    const w = this.manager.get(name);
    if (!w) return this.out({ t: 'toast', msg: 'Workspace names use a-z, 0-9, - and _' });
    if (this.w !== w) {
      this.detach();
      if (this.w) { this.w.release(this); this.w.off('sleep', this.onSleep); }
      this.w = w; this.current = null;
      w.on('sleep', this.onSleep);
      if (this.visible) w.lease(this);
    }
    this.sendWorkspaces();
    if (w.state !== 'awake') this.out({ t: 'state', state: 'waking', workspace: w.name });
    let chrome;
    try { chrome = await w.wake(); } catch (e) { return this.out({ t: 'state', state: 'error', workspace: w.name, msg: e.message }); }
    if (this.closed || this.w !== w || this.cdp) return;
    await this.connect(chrome);
  }

  async connect(chrome) {
    const w = this.w;
    const cdp = new WebSocket(await chrome.wsUrl(), { perMessageDeflate: false, maxPayload: 256 << 20 });
    await new Promise((ok, no) => { cdp.once('open', ok); cdp.once('error', no); });
    if (this.closed || this.w !== w || this.cdp) return cdp.close();
    this.cdp = cdp; this.id = 0; this.waiters = new Map(); this.targets.clear();
    cdp.on('message', raw => this.onCdp(JSON.parse(raw)));
    cdp.on('close', () => { if (this.cdp === cdp) this.detach('asleep'); });
    w.tabmap.on('update', this.tabsSoon = this.tabsSoon || (() => this.sendTabsSoon()));
    await this.send('Target.setDiscoverTargets', { discover: true });
    this.out({ t: 'state', state: 'awake', workspace: w.name });
    this.sendTabs();
    // open something right away: your most recent tab, else any tab, else a new one
    const pages = this.pageList();
    const pick = pages.find(p => !p.owner) || pages[0];
    if (pick) await this.view(pick.id);
    else await this.newTab();
  }

  detach(state) {
    this.stopStream();
    if (this.w && this.w.tabmap && this.tabsSoon) this.w.tabmap.off('update', this.tabsSoon);
    if (this.cdp) { const c = this.cdp; this.cdp = null; c.close(); }
    this.session = null; this.current = null;
    this.targets.clear();
    if (this.waiters) for (const r of this.waiters.values()) r({});
    this.waiters = new Map();
    if (state && this.w) this.out({ t: 'state', state, workspace: this.w.name, error: this.w.error });
  }

  send(method, params = {}, sessionId) {
    if (!this.cdp || this.cdp.readyState !== 1) return Promise.resolve({});
    return new Promise(resolve => {
      const i = ++this.id; this.waiters.set(i, resolve);
      this.cdp.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
  }
  onPage(method, params) { return this.session ? this.send(method, params, this.session) : Promise.resolve({}); }

  onCdp(msg) {
    if (msg.id) { const w = this.waiters.get(msg.id); this.waiters.delete(msg.id); return w && w(msg.result || { error: msg.error }); }
    const p = msg.params || {};
    if (msg.method === 'Target.targetCreated' || msg.method === 'Target.targetInfoChanged') {
      if (p.targetInfo.type === 'page') { this.targets.set(p.targetInfo.targetId, p.targetInfo); this.sendTabsSoon(); }
      return;
    }
    if (msg.method === 'Target.targetDestroyed') {
      if (this.targets.delete(p.targetId)) this.sendTabsSoon();
      if (p.targetId === this.current) this.onCurrentGone();
      return;
    }
    if (msg.sessionId !== this.session) return;
    switch (msg.method) {
      case 'Page.screencastFrame': return this.onJpeg(p);
      case 'Page.frameNavigated': if (!p.frame.parentId) this.out({ t: 'url', url: p.frame.url }); return;
      case 'Page.javascriptDialogOpening': return this.out({ t: 'dialog', type: p.type, message: p.message, value: p.defaultPrompt || '' });
      case 'Page.javascriptDialogClosed': return this.out({ t: 'dialog', closed: true });
      case 'Target.detachedFromTarget': return this.onCurrentGone();
    }
  }

  async onCurrentGone() {
    this.stopStream();
    if (this.current) this.targets.delete(this.current);
    this.session = null; this.current = null;
    if (!this.cdp) return;
    const next = this.pageList().find(p => !p.owner) || this.pageList()[0];
    if (next) await this.view(next.id); else this.out({ t: 'view', id: null });
  }

  pageList() {
    const owners = this.w && this.w.owners;
    return [...this.targets.values()]
      .filter(t => !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'))
      .map(t => ({ id: t.targetId, title: t.title, url: t.url, owner: (owners && owners.get(t.targetId)) || null }));
  }
  sendTabsSoon() { clearTimeout(this.tabsT); this.tabsT = setTimeout(() => this.sendTabs(), 60); }
  sendTabs() { if (this.cdp) this.out({ t: 'tabs', current: this.current, tabs: this.pageList() }); }

  // ---- viewing a tab ----

  async view(targetId) {
    if (!this.cdp) return;
    this.stopStream();
    if (this.session) { this.send('Target.detachFromTarget', { sessionId: this.session }); this.session = null; }
    this.current = targetId;
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true });
    if (!r.sessionId) return this.onCurrentGone();
    this.session = r.sessionId;
    this.out({ t: 'view', id: targetId });
    await this.send('Target.activateTarget', { targetId });
    await this.onPage('Page.enable');
    const { frameTree } = await this.onPage('Page.getFrameTree');
    if (frameTree) this.out({ t: 'url', url: frameTree.frame.url });
    this.sendTabs();
    await this.startStream();
  }

  async newTab(url = 'about:blank') {
    const r = await this.send('Target.createTarget', { url, newWindow: true });
    if (r.targetId) await this.view(r.targetId);
  }

  // Your own tabs render at the size of your viewer (phone-width on a phone);
  // agents' tabs keep their own size so watching them doesn't change the page.
  mine() { return this.w && !this.w.owners.get(this.current); }

  async startStream() {
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

  async mobileUA() {
    if (!this._ua) {
      const v = await this.send('Browser.getVersion');
      const ver = ((v.userAgent || '').match(/Chrome\/([\d.]+)/) || [, '140.0.0.0'])[1].replace(/\.\d+\.\d+\.\d+$/, '.0.0.0');
      this._ua = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Mobile Safari/537.36`;
    }
    return this._ua;
  }

  stopStream() {
    if (this.video) { this.video.stop(); this.video = null; }
    if (this.session) this.onPage('Page.stopScreencast');
  }

  restartStreamSoon() {
    clearTimeout(this.restartT);
    this.restartT = setTimeout(() => { this.stopStream(); this.startStream(); }, 250);
  }

  // Frames are acked to Chrome only once the viewer has them (2 in flight),
  // so a slow link lowers the frame rate instead of building a backlog.
  onJpeg(p) {
    const data = Buffer.from(p.data, 'base64');
    this.push(FRAME_JPEG, data, p.metadata.deviceWidth, p.metadata.deviceHeight);
    if (this.inflight < 2) this.send('Page.screencastFrameAck', { sessionId: p.sessionId }, this.session);
    else this.pendingAck = p.sessionId;
  }

  push(type, data, w, h) {
    const seq = ++this.seq;
    this.sent.set(seq, Date.now());
    this.inflight++;
    this.bytes += data.length; this.frames++;
    this.ws.send(Buffer.concat([header(type, seq, w, h), data]));
  }

  onAck(seq) {
    const t = this.sent.get(seq);
    if (t) {
      this.rtt = this.rtt ? this.rtt * 0.8 + (Date.now() - t) * 0.2 : Date.now() - t;
      for (const k of this.sent.keys()) { if (k > seq) break; this.sent.delete(k); }
    }
    this.inflight = this.sent.size;
    if (this.pendingAck && this.inflight < 2) {
      this.send('Page.screencastFrameAck', { sessionId: this.pendingAck }, this.session);
      this.pendingAck = null;
    }
  }

  async startVideo() {
    const targetId = this.current, w = this.w;
    const chrome = w.chrome;
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
    v.on('frame', (au, key) => {
      if (this.video !== v) return;
      // more than ~half a second behind: skip to the next keyframe
      if (this.inflight > this.cfg.fps / 2 || this.ws.bufferedAmount > 4 << 20) waitKey = true;
      if (waitKey && !key) return;
      waitKey = false;
      this.push(key ? FRAME_KEY : FRAME_DELTA, au, crop.w, crop.h);
    });
    v.on('error', e => {
      if (this.video !== v) return;
      this.video = null;
      this.mode = 'jpeg';
      this.out({ t: 'mode', mode: 'jpeg', msg: 'Video mode stopped: ' + e.message.split('\n')[0] });
      this.startStream();
    });
  }

  // adapt JPEG quality to the link: slow acks -> smaller frames
  stats() {
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

  // ---- messages from the page ----

  async onMessage(m) {
    switch (m.t) {
      case 'hello':
        this.stage = { w: m.w || 1280, h: m.h || 800, dpr: m.dpr || 1, mobile: !!m.mobile };
        if (m.mode === 'video' || m.mode === 'jpeg') this.mode = m.mode;
        this.visible = m.visible !== false;
        return this.useWorkspace(this.manager.get(m.workspace || '', { create: false }) ? m.workspace : 'default');
      case 'workspace': return this.useWorkspace(String(m.name || '').trim().toLowerCase());
      case 'wake': return this.useWorkspace(this.w ? this.w.name : 'default');
      case 'sleep': { const w = this.manager.get(m.name, { create: false }); return w && w.sleep(); }
      case 'delete': {
        if (m.name === 'default') return;
        if (this.w && this.w.name === m.name) await this.useWorkspace('default');
        return this.manager.remove(m.name);
      }
      case 'idle': {
        const w = this.manager.get(m.name, { create: false });
        return w && w.setSettings({ idleMinutes: m.minutes === null ? null : Math.max(0, Math.min(1440, +m.minutes || 0)) });
      }
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
      case 'keyframe': return this.mode === 'video' && this.restartStreamSoon();
      case 'ping': return this.out({ t: 'pong', ts: m.ts });
    }
    if (this.w) this.w.touch();
    if (!this.cdp) return;
    switch (m.t) {
      case 'view': return this.view(m.id);
      case 'new': return this.newTab(m.url);
      case 'close':
        await this.send('Target.closeTarget', { targetId: m.id });
        return;
      case 'nav': {
        let url = String(m.url).trim();
        if (!url) return;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = /^[^\s]+\.[^\s]+$|^localhost(:\d+)?(\/|$)/.test(url) ? 'https://' + url : 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
        if (!this.session) return this.newTab(url);
        return this.onPage('Page.navigate', { url });
      }
      case 'back': case 'fwd': {
        const h = await this.onPage('Page.getNavigationHistory');
        const e = h.entries && h.entries[h.currentIndex + (m.t === 'back' ? -1 : 1)];
        return e && this.onPage('Page.navigateToHistoryEntry', { entryId: e.id });
      }
      case 'reload': return this.onPage('Page.reload');
      case 'dialog': return this.onPage('Page.handleJavaScriptDialog', { accept: !!m.accept, promptText: m.text });
      case 'mouse':
        return this.onPage('Input.dispatchMouseEvent', {
          type: m.type, x: m.x, y: m.y, button: m.button || 'none', buttons: m.buttons || 0, clickCount: m.clickCount || 0,
          deltaX: m.dx || 0, deltaY: m.dy || 0, modifiers: MODS(m),
        });
      case 'key': {
        const cmd = (m.ctrl || m.meta) && EDIT[String(m.key).toLowerCase()];
        if (m.type === 'keyDown' && cmd === 'copy') {
          const r = await this.onPage('Runtime.evaluate', { expression: 'String(getSelection())' });
          if (r.result && r.result.value) this.out({ t: 'clip', text: r.result.value });
        }
        const text = !(m.ctrl || m.meta || m.alt) ? (m.key === 'Enter' ? '\r' : m.key.length === 1 ? m.key : '') : '';
        return this.onPage('Input.dispatchKeyEvent', {
          type: m.type === 'keyUp' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
          key: m.key, code: m.code, text: m.type === 'keyUp' ? undefined : text || undefined,
          windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: MODS(m),
          commands: m.type === 'keyDown' && cmd && cmd !== 'copy' && cmd !== 'paste' ? [cmd] : undefined,
        });
      }
      case 'text': return this.onPage('Input.insertText', { text: String(m.text) });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.statsTimer); clearInterval(this.tabsTimer);
    clearTimeout(this.restartT); clearTimeout(this.tabsT); clearTimeout(this.wsTimer);
    this.manager.off('change', this.onChange); this.manager.off('tick', this.onChange);
    this.detach();
    if (this.w) { this.w.release(this); this.w.off('sleep', this.onSleep); }
  }
}

const MODS = m => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
const EDIT = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

module.exports = { start };
