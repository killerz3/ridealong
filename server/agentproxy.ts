// Agent-facing CDP proxy. Every agent in a workspace shares that workspace's
// Chrome (same cookies/logins) but only sees and controls the tabs it opened,
// plus popups those tabs open. Tabs you open yourself stay invisible to agents.
//   ws://127.0.0.1:9230/<workspace>/<agent>/devtools/browser
//   ws://127.0.0.1:9230/<agent>/devtools/browser        (workspace "default")
// Connecting wakes the workspace, creating it if it doesn't exist yet.
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { Manager, Workspace } from './workspaces.js';
import type { CdpMsg, TabMap, TargetInfo } from './tabmap.js';
import type { Owners } from './owners.js';

const LOG = process.env.RIDEALONG_LOG;
const TAB_TYPES = new Set(['page', 'tab']);
const HOLD_MS = 2000;
const ROUTE = /^\/(?:([^/]+)\/)?([\w.-]+)\/(devtools\/browser|json(?:\/version|\/list)?)\/?(?:\?.*)?$/;

const resolve = (manager: Manager, url = '') => {
  const m = url.match(ROUTE);
  if (!m) return null;
  const w = manager.get(m[1] || 'default');
  return w && { w, bot: m[2], what: m[3] };
};

const json = (res: http.ServerResponse, v: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(v, null, 2));
};

export function start({ port, bind, manager }: { port: number; bind: string; manager: Manager }): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const base = `ws://${req.headers.host || '127.0.0.1:' + port}`;
    try {
      // small management API for the CLI; this port is trusted (keep it on loopback)
      if (req.url === '/api/workspaces') return json(res, manager.list());
      const api = req.url?.match(/^\/api\/workspaces\/([^/]+)\/(wake|sleep)$/);
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
      if (r.w.blocked.includes(r.bot)) return json(res, { error: `agent "${r.bot}" is blocked in workspace "${r.w.name}"` }, 403);
      const chrome = await r.w.wake();
      if (r.what === 'json/version') {
        const v = await (await fetch(`${chrome.http}/json/version`)).json();
        v.webSocketDebuggerUrl = `${base}/${r.w.name}/${r.bot}/devtools/browser`;
        return json(res, v);
      }
      const list = await (await fetch(`${chrome.http}/json/list`)).json() as { id: string; type: string }[];
      json(res, list.filter(t => !TAB_TYPES.has(t.type) || r.w.owners.get(t.id) === r.bot)
        .map(t => ({ ...t, webSocketDebuggerUrl: undefined, devtoolsFrontendUrl: undefined })));
    } catch (e) { json(res, { error: (e as Error).message }, 500); }
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (client, req) => {
    const r = resolve(manager, req.url);
    if (!r || r.what !== 'devtools/browser') return client.close(1008, 'use /<workspace>/<agent>/devtools/browser');
    if (r.w.blocked.includes(r.bot)) return client.close(1008, `agent "${r.bot}" is blocked in the ridealong viewer`);
    proxy(client, r.w, r.bot);
  });

  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, bind, () => ok(server)); });
}

function proxy(client: WebSocket, w: Workspace, bot: string) {
  const log = (...a: unknown[]) => LOG && console.log(`[${w.name}/${bot}]`, ...a);
  let tabmap: TabMap, owners: Owners; // set once the workspace is awake
  w.agentJoin(bot);

  let up: WebSocket | null = null;
  const upQueue: string[] = [];
  const upSend = (msg: CdpMsg) => (up && up.readyState === 1) ? up.send(JSON.stringify(msg)) : upQueue.push(JSON.stringify(msg));
  const toClient = (msg: CdpMsg) => client.readyState === 1 && client.send(JSON.stringify(msg));

  const pending = new Map<number, { method: string; url?: string }>(); // client request id -> method
  const sessions = new Set<string>();   // sessions this bot may use
  const visible = new Set<string>();    // target ids shown to this bot
  const allTargets = new Map<string, TargetInfo>(); // everything upstream reported
  let creating = 0;                     // in-flight Target.createTarget calls
  let ownId = -1;

  // 'yes' | 'no' | 'wait' (ownership not decidable yet)
  const verdict = (info?: TargetInfo): 'yes' | 'no' | 'wait' => {
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
  const deliver = (msg: CdpMsg, force = false): boolean => {
    if (msg.id !== undefined) return toClient(msg), true;
    const p = msg.params || {};
    const info: TargetInfo | undefined = p.targetInfo;
    switch (msg.method) {
      case 'Target.targetCreated': case 'Target.targetInfoChanged': {
        const v = verdict(info);
        if (v === 'wait' && !force) return false;
        if (v !== 'yes') return true;
        visible.add(info!.targetId);
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
          log('hide', info!.type, info!.targetId);
          // always: popups can be held even when waitingForDebugger is false
          upSend({ id: ownId--, sessionId: p.sessionId, method: 'Runtime.runIfWaitingForDebugger' });
          upSend({ id: ownId--, method: 'Target.detachFromTarget', params: { sessionId: p.sessionId }, ...(msg.sessionId && { sessionId: msg.sessionId }) });
          return true;
        }
        visible.add(info!.targetId);
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
  const held: CdpMsg[] = [];
  let holdTimer: NodeJS.Timeout | null = null;
  const drain = (force = false) => {
    while (held.length) {
      if (!deliver(held[0], force)) return;
      held.shift(); force = false;
    }
    if (holdTimer) clearInterval(holdTimer);
    holdTimer = null;
  };
  const onMapUpdate = () => drain();

  const onUp = (raw: WebSocket.RawData) => {
    if (LOG === '2') console.log('<', String(raw).slice(0, 180));
    const msg: CdpMsg = JSON.parse(String(raw));
    if (msg.id !== undefined && msg.id < 0) return; // replies to our housekeeping
    if (msg.id !== undefined) {
      const req = pending.get(msg.id); pending.delete(msg.id);
      if (req?.method === 'Target.createTarget') {
        creating--;
        if (msg.result) {
          owners.set(msg.result.targetId, bot);
          w.log('open', bot, { url: req.url && req.url !== 'about:blank' ? req.url : undefined });
          w.changed();
          log('owns', msg.result.targetId);
        }
      }
      if (req?.method === 'Target.getTargets' && msg.result) msg.result.targetInfos = msg.result.targetInfos.filter((i: TargetInfo) => verdict(i) === 'yes');
    }
    const info = msg.params?.targetInfo;
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

  const early: WebSocket.RawData[] = [];
  const onClient = (raw: WebSocket.RawData) => {
    w.touch(bot);
    if (!up) return void early.push(raw);
    if (LOG === '2') console.log('>', String(raw).slice(0, 180));
    const msg: CdpMsg & { id: number; method: string } = JSON.parse(String(raw));
    const p = msg.params || {};
    const deny = (why: string) => {
      log('deny', msg.method, why);
      toClient({ id: msg.id, sessionId: msg.sessionId, error: { code: -32000, message: `ridealong: ${why}` } });
    };
    if (/^Target\.(attachToTarget|closeTarget|activateTarget|exposeDevToolsProtocol)$/.test(msg.method) && p.targetId) {
      const info = allTargets.get(p.targetId) || { targetId: p.targetId, type: 'page', url: '', title: '' };
      if (!visible.has(p.targetId) && verdict(info) !== 'yes') return deny('tab not owned by this bot');
    }
    if (msg.sessionId && !sessions.has(msg.sessionId)) return deny('unknown session');
    // own window per bot tab, so every tab keeps rendering (no background throttling)
    if (msg.method === 'Target.createTarget') { creating++; msg.params = { ...p, newWindow: true }; }
    pending.set(msg.id, { method: msg.method, url: p.url });
    upSend(msg);
  };
  client.on('message', onClient);

  let closed = false;
  const onKick = (name: string) => { if (name === bot) close(); };
  const close = () => {
    if (closed) return; closed = true;
    w.agentLeave(bot);
    w.off('sleep', close);
    w.off('kick', onKick);
    tabmap?.off('update', onMapUpdate);
    if (holdTimer) clearInterval(holdTimer);
    client.close(); up?.close();
  };
  client.on('close', close); client.on('error', close);
  w.on('sleep', close); // the workspace went to sleep: the agent reconnects to wake it
  w.on('kick', onKick);

  w.wake().then(async chrome => {
    if (closed) return;
    tabmap = w.tabmap!; owners = w.owners;
    tabmap.on('update', onMapUpdate);
    const sock = new WebSocket(await chrome.wsUrl(), { perMessageDeflate: false, maxPayload: 256 << 20 });
    sock.on('open', () => {
      up = sock;
      upQueue.splice(0).forEach(m => sock.send(m));
      early.splice(0).forEach(onClient);
    });
    sock.on('message', onUp);
    sock.on('close', close); sock.on('error', close);
  }).catch(e => { log('workspace failed to start', e.message); close(); });
}
