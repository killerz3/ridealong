// Agent-facing CDP proxy. Every agent in a workspace shares that workspace's
// Chrome (same cookies/logins) but only sees and controls the tabs it opened,
// plus popups those tabs open. Tabs you open yourself stay invisible to agents.
//   ws://127.0.0.1:9230/<workspace>/<agent>/devtools/browser
//   ws://127.0.0.1:9230/<agent>/devtools/browser        (workspace "default")
// Connecting wakes the workspace, creating it if it doesn't exist yet.
const http = require('http');
const WebSocket = require('ws');

const LOG = !!process.env.TABKENNEL_LOG;
const TAB_TYPES = new Set(['page', 'tab']);
const HOLD_MS = 2000;
const ROUTE = /^\/(?:([^/]+)\/)?([\w.-]+)\/(devtools\/browser|json(?:\/version|\/list)?)\/?(?:\?.*)?$/;

const resolve = (manager, url) => {
  const m = url.match(ROUTE);
  if (!m) return null;
  const w = manager.get(m[1] || 'default');
  return w && { w, bot: m[2], what: m[3] };
};

function start({ port, bind, manager }) {
  const server = http.createServer(async (req, res) => {
    const base = `ws://${req.headers.host || '127.0.0.1:' + port}`;
    try {
      // small management API for the CLI; this port is trusted (keep it on loopback)
      if (req.url === '/api/workspaces') return json(res, manager.list());
      const api = req.url.match(/^\/api\/workspaces\/([^/]+)\/(wake|sleep)$/);
      if (api && req.method === 'POST') {
        const w = manager.get(api[1]);
        if (!w) return json(res, { error: 'bad workspace name' }, 400);
        await (api[2] === 'wake' ? w.wake() : w.sleep());
        return json(res, w.info());
      }
      const r = resolve(manager, req.url);
      if (!r || r.what === 'devtools/browser') {
        return json(res, { error: `connect to ${base}/<workspace>/<agent>/devtools/browser`, workspaces: manager.list().map(w => w.name) }, 404);
      }
      const chrome = await r.w.wake();
      if (r.what === 'json/version') {
        const v = await (await fetch(`${chrome.http}/json/version`)).json();
        v.webSocketDebuggerUrl = `${base}/${r.w.name}/${r.bot}/devtools/browser`;
        return json(res, v);
      }
      const list = await (await fetch(`${chrome.http}/json/list`)).json();
      json(res, list.filter(t => !TAB_TYPES.has(t.type) || r.w.owners.get(t.id) === r.bot).map(t => ({ ...t, webSocketDebuggerUrl: undefined, devtoolsFrontendUrl: undefined })));
    } catch (e) { json(res, { error: e.message }, 500); }
  });

  const wss = new WebSocket.Server({ server });
  wss.on('connection', (client, req) => {
    const r = resolve(manager, req.url);
    if (!r || r.what !== 'devtools/browser') return client.close(1008, 'use /<workspace>/<agent>/devtools/browser');
    const { w, bot } = r;
    const log = (...a) => LOG && console.log(`[${w.name}/${bot}]`, ...a);
    let tabmap, owners; // set once the workspace is awake
    w.agentJoin(bot);

    let up = null;
    const upQueue = [];
    const upSend = msg => (up && up.readyState === 1) ? up.send(JSON.stringify(msg)) : upQueue.push(JSON.stringify(msg));
    const toClient = msg => client.readyState === 1 && client.send(JSON.stringify(msg));

    const pending = new Map();    // client request id -> method
    const sessions = new Set();   // sessions this bot may use
    const visible = new Set();    // target ids shown to this bot
    const allTargets = new Map(); // targetId -> targetInfo, everything upstream reported
    let creating = 0;             // in-flight Target.createTarget calls
    let ownId = -1;

    // 'yes' | 'no' | 'wait' (ownership not decidable yet)
    const verdict = info => {
      if (!info || !TAB_TYPES.has(info.type)) return 'yes';
      const o = tabmap.ownerOf(info);
      if (o) return o === bot ? 'yes' : 'no';
      if (info.type === 'page' && info.openerId && owners.get(info.openerId) === bot) { owners.set(info.targetId, bot); return 'yes'; }
      if (creating > 0) return 'wait';
      // a brand-new tab's page shows up a moment after the tab itself;
      // older unmapped tabs are browser UI (toolbar, omnibox) with no page
      if (info.type === 'tab' && !tabmap.tabToPage.has(info.targetId)) {
        const seen = tabmap.seen.get(info.targetId);
        if (!seen || Date.now() - seen < 1000) return 'wait';
      }
      return 'no';
    };

    // returns false if msg must keep waiting
    const deliver = (msg, force) => {
      if (msg.id !== undefined) return toClient(msg), true;
      const p = msg.params || {};
      const info = p.targetInfo;
      switch (msg.method) {
        case 'Target.targetCreated': case 'Target.targetInfoChanged': {
          const v = verdict(info);
          if (v === 'wait' && !force) return false;
          if (v !== 'yes') return true;
          visible.add(info.targetId);
          break;
        }
        case 'Target.targetDestroyed': case 'Target.targetCrashed': {
          const t = allTargets.get(p.targetId);
          if (t && TAB_TYPES.has(t.type) && !visible.has(p.targetId)) return true;
          break;
        }
        case 'Target.attachedToTarget': {
          const v = verdict(info);
          if (v === 'wait' && !force) return false;
          if (v !== 'yes') {
            // auto-attach grabbed someone else's tab: let it run, detach
            log('hide', info.type, info.targetId);
            if (p.waitingForDebugger) upSend({ id: ownId--, sessionId: p.sessionId, method: 'Runtime.runIfWaitingForDebugger' });
            upSend({ id: ownId--, method: 'Target.detachFromTarget', params: { sessionId: p.sessionId }, ...(msg.sessionId && { sessionId: msg.sessionId }) });
            return true;
          }
          visible.add(info.targetId);
          sessions.add(p.sessionId);
          break;
        }
        case 'Target.detachedFromTarget':
          if (!sessions.delete(p.sessionId)) return true;
          break;
      }
      if (msg.sessionId && !sessions.has(msg.sessionId)) return true;
      toClient(msg);
      return true;
    };

    // Upstream messages are delivered in order; one undecidable event holds
    // the stream until the createTarget reply / tab map catches up.
    const held = [];
    let holdTimer = null;
    const drain = (force = false) => {
      while (held.length) {
        if (!deliver(held[0], force)) return;
        held.shift(); force = false;
      }
      clearInterval(holdTimer); holdTimer = null;
    };
    const onMapUpdate = () => drain();

    const onUp = raw => {
      if (process.env.TABKENNEL_LOG === '2') console.log('<', String(raw).slice(0, 180));
      const msg = JSON.parse(raw);
      if (msg.id < 0) return; // replies to our housekeeping
      if (msg.id !== undefined) {
        const method = pending.get(msg.id); pending.delete(msg.id);
        if (method === 'Target.createTarget') {
          creating--;
          if (msg.result) { owners.set(msg.result.targetId, bot); log('owns', msg.result.targetId); }
        }
        if (method === 'Target.getTargets' && msg.result) msg.result.targetInfos = msg.result.targetInfos.filter(i => verdict(i) === 'yes');
      }
      const info = msg.params && msg.params.targetInfo;
      if (info) allTargets.set(info.targetId, info);
      if (held.length || !deliver(msg)) held.push(msg);
      if (held.length) {
        drain();
        if (held.length && !holdTimer) {
          const since = Date.now();
          holdTimer = setInterval(() => drain(Date.now() - since > HOLD_MS), 200);
        }
      }
    };

    const early = [];
    const onClient = raw => {
      w.touch();
      if (!up) return early.push(raw);
      if (process.env.TABKENNEL_LOG === '2') console.log('>', String(raw).slice(0, 180));
      const msg = JSON.parse(raw);
      const p = msg.params || {};
      const deny = why => { log('deny', msg.method, why); toClient({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: `tabkennel: ${why}` } }); };
      if (/^Target\.(attachToTarget|closeTarget|activateTarget|exposeDevToolsProtocol)$/.test(msg.method) && p.targetId) {
        const info = allTargets.get(p.targetId) || { targetId: p.targetId, type: 'page' };
        if (!visible.has(p.targetId) && verdict(info) !== 'yes') return deny('tab not owned by this bot');
      }
      if (msg.sessionId && !sessions.has(msg.sessionId)) return deny('unknown session');
      // own window per bot tab, so every tab keeps rendering (no background throttling)
      if (msg.method === 'Target.createTarget') { creating++; msg.params = { ...p, newWindow: true }; }
      pending.set(msg.id, msg.method);
      upSend(msg);
    };
    client.on('message', onClient);

    let closed = false;
    const close = () => {
      if (closed) return; closed = true;
      w.agentLeave(bot);
      w.off('sleep', close);
      if (tabmap) tabmap.off('update', onMapUpdate);
      clearInterval(holdTimer);
      client.close(); up && up.close();
    };
    client.on('close', close); client.on('error', close);
    w.on('sleep', close); // the workspace went to sleep: the agent reconnects to wake it

    w.wake().then(async chrome => {
      if (closed) return;
      ({ tabmap, owners } = w);
      tabmap.on('update', onMapUpdate);
      const sock = new WebSocket(await chrome.wsUrl(), { perMessageDeflate: false, maxPayload: 256 << 20 });
      sock.on('open', () => {
        up = sock;
        upQueue.splice(0).forEach(m => up.send(m));
        early.splice(0).forEach(onClient);
      });
      sock.on('message', onUp);
      sock.on('close', close); sock.on('error', close);
    }).catch(e => { log('workspace failed to start', e.message); close(); });
  });

  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, bind, () => ok(server)); });
}

function json(res, v, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(v, null, 2)); }

module.exports = { start };
