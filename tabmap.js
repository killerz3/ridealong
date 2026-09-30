// Recent Chrome exposes every tab twice: a "tab" target and the "page" inside
// it, with different ids. Bots (puppeteer) see tabs, ownership is recorded on
// pages, so keep a live tab -> page map from a side CDP connection.
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const owners = require('./owners');

const map = new EventEmitter();
map.tabToPage = new Map();
map.seen = new Map(); // tabId -> first time we saw it attach
map.setMaxListeners(0);

function connect(chrome) {
  let id = 0;
  const tabSessions = new Map(); // sessionId -> tabId
  fetch(`${chrome}/json/version`).then(r => r.json()).then(({ webSocketDebuggerUrl }) => {
    const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false });
    const send = (method, params, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
    ws.on('open', () => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'tab' }] }));
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      const p = msg.params || {};
      if (msg.method === 'Target.attachedToTarget') {
        const t = p.targetInfo;
        if (t.type === 'tab' && !msg.sessionId) {
          tabSessions.set(p.sessionId, t.targetId);
          map.seen.set(t.targetId, Date.now());
          send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'page' }] }, p.sessionId);
        } else if (t.type === 'page' && tabSessions.has(msg.sessionId)) {
          // a popup inherits its opener's owner
          if (!owners.get(t.targetId) && t.openerId && owners.get(t.openerId)) owners.set(t.targetId, owners.get(t.openerId));
          map.tabToPage.set(tabSessions.get(msg.sessionId), t.targetId);
          map.emit('update');
        }
      } else if (msg.method === 'Target.detachedFromTarget' && tabSessions.has(p.sessionId)) {
        map.tabToPage.delete(tabSessions.get(p.sessionId));
        map.seen.delete(tabSessions.get(p.sessionId));
        tabSessions.delete(p.sessionId);
      }
    });
    ws.on('close', () => setTimeout(() => connect(chrome), 2000));
    ws.on('error', () => {});
  }).catch(() => setTimeout(() => connect(chrome), 2000));
}

map.start = connect;
// owner of a page or tab target id
map.ownerOf = (info) => owners.get(info.type === 'tab' ? map.tabToPage.get(info.targetId) : info.targetId);
module.exports = map;
