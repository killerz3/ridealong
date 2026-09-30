// Web viewer: streams any tab of the shared Chrome to your browser (CDP
// screencast) and forwards mouse/keyboard back. Password-gated; meant to sit
// behind a tunnel.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const owners = require('./owners');

function start({ port, chrome, password }) {
  const secret = crypto.createHash('sha256').update('ab:' + password).digest('hex');
  const authed = req => (req.headers.cookie || '').split(/;\s*/).includes('ab=' + secret);
  const ui = fs.readFileSync(path.join(__dirname, 'ui.html'));

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/login') {
      let body = '';
      req.on('data', c => body += c);
      return req.on('end', () => {
        const ok = new URLSearchParams(body).get('password') === password;
        res.writeHead(303, { location: '/', ...(ok && { 'set-cookie': `ab=${secret}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` }) });
        res.end();
      });
    }
    if (!authed(req)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><meta name=viewport content="width=device-width"><title>agent-browser</title>
<body style="background:#0b0d10;color:#ddd;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<form method=post action=/login><input name=password type=password placeholder=password autofocus
style="background:#15181d;border:1px solid #2a2f37;color:#eee;padding:10px 14px;border-radius:8px;font:inherit"></form>`);
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(ui);
  });

  const wss = new WebSocket.Server({ server, verifyClient: ({ req }) => authed(req) });
  wss.on('connection', async ws => {
    const out = m => ws.readyState === 1 && ws.send(JSON.stringify(m));
    let id = 0, session = null, current = null;
    const waiters = new Map();
    let cdp;
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`${chrome}/json/version`)).json();
      cdp = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 << 20 });
      await new Promise((ok, err) => { cdp.once('open', ok); cdp.once('error', err); });
    } catch { out({ t: 'error', msg: 'chrome is not running' }); return ws.close(); }

    const send = (method, params = {}, sessionId) => new Promise(resolve => {
      const i = ++id; waiters.set(i, resolve);
      cdp.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
    const onPage = (method, params = {}) => session ? send(method, params, session) : Promise.resolve({});

    cdp.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id) { const w = waiters.get(msg.id); waiters.delete(msg.id); return w && w(msg.result || { error: msg.error }); }
      if (msg.sessionId !== session) return;
      if (msg.method === 'Page.screencastFrame') {
        out({ t: 'frame', data: msg.params.data, meta: msg.params.metadata });
        send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }, session);
      } else if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
        out({ t: 'url', url: msg.params.frame.url });
      }
    });

    const tabs = async () => {
      try {
        const list = await (await fetch(`${chrome}/json/list`)).json();
        out({ t: 'tabs', current, tabs: list.filter(t => t.type === 'page' && !t.url.startsWith('devtools://'))
          .map(t => ({ id: t.id, title: t.title, url: t.url, owner: owners.get(t.id) || null })) });
      } catch {}
    };
    const iv = setInterval(tabs, 1500); tabs();

    const view = async targetId => {
      if (session) { onPage('Page.stopScreencast'); send('Target.detachFromTarget', { sessionId: session }); session = null; }
      current = targetId;
      const r = await send('Target.attachToTarget', { targetId, flatten: true });
      if (!r.sessionId) return out({ t: 'error', msg: 'tab is gone' });
      session = r.sessionId;
      await send('Target.activateTarget', { targetId });
      await onPage('Page.enable');
      const { frameTree } = await onPage('Page.getFrameTree');
      if (frameTree) out({ t: 'url', url: frameTree.frame.url });
      await onPage('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 2560, maxHeight: 1600 });
      tabs();
    };

    const MODS = m => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
    const EDIT = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

    ws.on('message', async raw => {
      const m = JSON.parse(raw);
      switch (m.t) {
        case 'view': return view(m.id);
        case 'new': {
          const r = await send('Target.createTarget', { url: m.url || 'about:blank', newWindow: true });
          return r.targetId && view(r.targetId);
        }
        case 'close': send('Target.closeTarget', { targetId: m.id }); if (m.id === current) { session = null; current = null; } return tabs();
        case 'nav': {
          let url = m.url.trim();
          if (!/^[a-z]+:/i.test(url)) url = /^[^\s]+\.[^\s]+$/.test(url) ? 'https://' + url : 'https://www.google.com/search?q=' + encodeURIComponent(url);
          return onPage('Page.navigate', { url });
        }
        case 'back': case 'fwd': {
          const h = await onPage('Page.getNavigationHistory');
          const e = h.entries && h.entries[h.currentIndex + (m.t === 'back' ? -1 : 1)];
          return e && onPage('Page.navigateToHistoryEntry', { entryId: e.id });
        }
        case 'reload': return onPage('Page.reload');
        case 'mouse':
          return onPage('Input.dispatchMouseEvent', { type: m.type, x: m.x, y: m.y, button: m.button || 'none',
            buttons: m.buttons || 0, clickCount: m.clickCount || 0, deltaX: m.dx || 0, deltaY: m.dy || 0, modifiers: MODS(m) });
        case 'key': {
          const mods = MODS(m);
          const cmd = (m.ctrl || m.meta) && EDIT[m.key.toLowerCase()];
          if (m.type === 'keyDown' && cmd === 'copy') {
            const r = await onPage('Runtime.evaluate', { expression: 'String(getSelection())' });
            if (r.result) out({ t: 'clip', text: r.result.value });
          }
          const text = !(m.ctrl || m.meta || m.alt) ? (m.key === 'Enter' ? '\r' : m.key.length === 1 ? m.key : '') : '';
          return onPage('Input.dispatchKeyEvent', {
            type: m.type === 'keyUp' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
            key: m.key, code: m.code, text: m.type === 'keyUp' ? undefined : text || undefined,
            windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: mods,
            commands: m.type === 'keyDown' && cmd && cmd !== 'copy' && cmd !== 'paste' ? [cmd] : undefined,
          });
        }
        case 'text': return onPage('Input.insertText', { text: m.text });
      }
    });

    const close = () => { clearInterval(iv); cdp.close(); };
    ws.on('close', close); cdp.on('close', () => ws.close());
  });

  server.listen(port, '127.0.0.1', () => console.log(`viewer on http://127.0.0.1:${port}`));
}

module.exports = { start };
