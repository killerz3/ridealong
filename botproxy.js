// Per-bot CDP proxy: every bot shares one Chrome (same cookies/logins) but
// only sees and controls the tabs it opened (plus popups those tabs open).
// Tabs you open yourself in the viewer stay invisible to every bot.
//   ws://127.0.0.1:9230/<bot>/devtools/browser
const http = require('http');
const WebSocket = require('ws');
const owners = require('./owners');
const tabmap = require('./tabmap');

const LOG = !!process.env.AB_LOG;
const TAB_TYPES = new Set(['page', 'tab']);
const HOLD_MS = 2000;

function start({ port, chrome }) {
  tabmap.start(chrome);

  const server = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/([\w.-]+)\/json(\/version|\/list)?\/?$/);
    if (!m) { res.writeHead(404); return res.end('connect to ws://127.0.0.1:' + port + '/<bot>/devtools/browser'); }
    const bot = m[1];
    if (m[2] === '/version') {
      const v = await (await fetch(`${chrome}/json/version`)).json();
      v.webSocketDebuggerUrl = `ws://127.0.0.1:${port}/${bot}/devtools/browser`;
      return json(res, v);
    }
    const list = await (await fetch(`${chrome}/json/list`)).json();
    json(res, list.filter(t => !TAB_TYPES.has(t.type) || owners.get(t.id) === bot));
  });

  const wss = new WebSocket.Server({ server });
  wss.on('connection', (client, req) => {
    const m = req.url.match(/^\/([\w.-]+)\/devtools\/browser/);
    if (!m) return client.close();
    const bot = m[1];
    const log = (...a) => LOG && console.log(`[${bot}]`, ...a);

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
    tabmap.on('update', onMapUpdate);

    const onUp = raw => {
      if (process.env.AB_LOG === '2') console.log('<', String(raw).slice(0, 180));
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

    client.on('message', raw => {
      if (process.env.AB_LOG === '2') console.log('>', String(raw).slice(0, 180));
      const msg = JSON.parse(raw);
      const p = msg.params || {};
      const deny = why => { log('deny', msg.method, why); toClient({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: `agent-browser: ${why}` } }); };
      if (/^Target\.(attachToTarget|closeTarget|activateTarget|exposeDevToolsProtocol)$/.test(msg.method) && p.targetId) {
        const info = allTargets.get(p.targetId) || { targetId: p.targetId, type: 'page' };
        if (!visible.has(p.targetId) && verdict(info) !== 'yes') return deny('tab not owned by this bot');
      }
      if (msg.sessionId && !sessions.has(msg.sessionId)) return deny('unknown session');
      // own window per bot tab, so every tab keeps rendering (no background throttling)
      if (msg.method === 'Target.createTarget') { creating++; msg.params = { ...p, newWindow: true }; }
      pending.set(msg.id, msg.method);
      upSend(msg);
    });

    const close = () => { tabmap.off('update', onMapUpdate); clearInterval(holdTimer); client.close(); up && up.close(); };
    client.on('close', close); client.on('error', close);

    fetch(`${chrome}/json/version`).then(r => r.json()).then(({ webSocketDebuggerUrl }) => {
      up = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 << 20 });
      up.on('open', () => upQueue.splice(0).forEach(m => up.send(m)));
      up.on('message', onUp);
      up.on('close', close); up.on('error', close);
    }).catch(e => { log('chrome unreachable', e.message); close(); });
  });

  server.listen(port, '127.0.0.1', () => console.log(`bot proxy on ws://127.0.0.1:${port}/<bot>/devtools/browser`));
}

function json(res, v) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); }

module.exports = { start };
