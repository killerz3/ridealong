// The viewer socket: sends what you do, applies what the server says, and
// draws frames. Frames are acknowledged only once drawn (JPEG) or received
// (video), which is what keeps a slow link from building a backlog.
import { toast } from 'sonner';
import { FRAME_JPEG, FRAME_KEY, HEADER_BYTES, type ClientMsg, type ServerMsg, type Stage, type StreamMode } from '@shared/protocol';
import { blankPage, get, set } from './store';
import { prefs } from './prefs';

export const VIDEO_OK = typeof window !== 'undefined' && 'VideoDecoder' in window;
export const MOBILE = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;

let sock: WebSocket | null = null;
let retry = 0;
let stageEl: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let lastDrawn = 0;
let decoder: VideoDecoder | null = null;
let needKey = true;
let videoSize = { w: 0, h: 0 };
let downloadsOf: string | null = null;

export function send(m: ClientMsg) {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m));
}

// ---------- routing: #/<workspace>[/overview] ----------
export function readHash() {
  const [ws, view] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  return { ws: ws || null, view: view === 'overview' ? 'overview' as const : 'browser' as const };
}
export function writeHash() {
  const { ws, view } = get();
  if (!ws) return;
  const h = ws === 'default' && view === 'browser' ? '' : `#/${ws}${view === 'overview' ? '/overview' : ''}`;
  if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
}

export function stageSize(): Stage {
  const r = stageEl?.getBoundingClientRect();
  return { w: Math.round(r?.width || 1280), h: Math.round(r?.height || 800), dpr: devicePixelRatio || 1, mobile: MOBILE };
}

export function connect() {
  set({ link: 'connecting' });
  const s = sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  s.binaryType = 'arraybuffer';
  s.onopen = () => {
    retry = 0;
    set({ link: 'open' });
    const { mode } = get();
    downloadsOf = null;
    send({ t: 'hello', workspace: readHash().ws || prefs.get<string | null>('ws', null), mode: VIDEO_OK ? mode : 'jpeg', visible: !document.hidden, ...stageSize() });
    if (get().view === 'overview') send({ t: 'thumbs', on: true });
  };
  s.onclose = () => {
    if (sock !== s) return;
    set({ link: 'closed', wsState: 'connecting', hasFrame: false });
    // the cookie may have expired: check before reconnecting
    fetch('/api/boot').then(r => r.json()).then(b => {
      if (!b.authed) return set({ boot: b });
      setTimeout(connect, Math.min(5000, 600 * 2 ** retry++));
    }, () => setTimeout(connect, Math.min(5000, 600 * 2 ** retry++)));
  };
  s.onmessage = e => typeof e.data === 'string' ? onJson(JSON.parse(e.data)) : onFrame(e.data);
}

function onJson(m: ServerMsg) {
  switch (m.t) {
    case 'workspaces':
      set(s => ({ workspaces: m.list, ws: m.current ?? s.ws }));
      break;
    case 'state': {
      set({ ws: m.workspace, wsState: m.state, wsError: m.error || null });
      prefs.set('ws', m.workspace);
      if (m.state !== 'awake') { set({ tabs: [], tab: null, page: blankPage, hasFrame: false, loading: false }); resetVideo(); }
      writeHash();
      break;
    }
    case 'tabs': set({ tabs: m.tabs, ...(m.current !== undefined && { tab: m.current }) }); break;
    case 'view':
      set({ tab: m.id, page: blankPage, hasFrame: false, frame: null, loading: false, dialog: null, chooser: null });
      resetVideo();
      break;
    case 'page': set({ page: { url: m.url, title: m.title, canBack: m.canBack, canFwd: m.canFwd } }); rememberUrl(m.url, m.title); break;
    case 'loading': set({ loading: m.on }); break;
    case 'clip': navigator.clipboard?.writeText(m.text).catch(() => {}); break;
    case 'dialog': set({ dialog: 'closed' in m ? null : { type: m.type, message: m.message, value: m.value } }); break;
    case 'filechooser': set({ chooser: { multiple: m.multiple } }); break;
    case 'mode':
      set({ mode: m.mode }); resetVideo();
      if (m.msg) toast.error(m.msg);
      break;
    case 'stats': set({ stats: m }); break;
    case 'pong': set({ pingRtt: Math.round(performance.now() - m.ts) }); break;
    case 'toast': m.kind === 'error' ? toast.error(m.msg) : toast(m.msg); break;
    case 'activity':
      if (m.workspace !== get().ws && !m.reset) break;
      set(s => ({
        activity: m.reset ? m.items : [...s.activity, ...m.items].slice(-200),
        unseenActivity: m.reset || s.activityOpen ? 0 : s.unseenActivity + m.items.filter(i => i.agent).length,
      }));
      break;
    case 'downloads': {
      const initial = downloadsOf !== m.workspace;
      downloadsOf = m.workspace;
      const before = new Map(get().downloads.map(d => [d.id, d]));
      set(s => ({ downloads: m.items, unseenDownloads: initial ? 0 : s.unseenDownloads + m.items.filter(d => !before.has(d.id)).length }));
      if (initial) break;
      for (const d of m.items) {
        const was = before.get(d.id);
        if (!was) toast(`Downloading ${d.name}`, { description: 'It shows up under Downloads in the toolbar.' });
        else if (was.state === 'inProgress' && d.state === 'completed') toast.success(`Downloaded ${d.name}`, { action: { label: 'Save', onClick: () => saveDownload(d.id) } });
      }
      break;
    }
    case 'thumb': set(s => ({ thumbs: { ...s.thumbs, [m.id]: 'data:image/jpeg;base64,' + m.data } })); break;
    case 'screenshot': {
      const a = document.createElement('a');
      a.href = 'data:image/png;base64,' + m.data;
      a.download = m.name;
      a.click();
      toast.success('Screenshot saved', { description: m.name });
      break;
    }
  }
}

// ---------- frames ----------
export function attachStage(stage: HTMLElement | null, c: HTMLCanvasElement | null) {
  stageEl = stage; canvas = c;
  ctx = c ? c.getContext('2d', { alpha: false, desynchronized: true }) : null;
}

function onFrame(buf: ArrayBuffer) {
  const dv = new DataView(buf);
  const type = dv.getUint8(0), seq = dv.getUint32(4, true), w = dv.getFloat32(8, true), h = dv.getFloat32(12, true);
  const data = new Uint8Array(buf, HEADER_BYTES);
  if (type === FRAME_JPEG) {
    createImageBitmap(new Blob([data], { type: 'image/jpeg' })).then(img => {
      if (seq > lastDrawn) { lastDrawn = seq; draw(img, w, h); }
      img.close();
      send({ t: 'ack', seq });
    }, () => send({ t: 'ack', seq }));
  } else {
    send({ t: 'ack', seq });
    decodeVideo(type === FRAME_KEY, data, w, h);
  }
}

function draw(src: ImageBitmap | VideoFrame, w: number, h: number) {
  if (!canvas || !ctx) return;
  const sw = 'displayWidth' in src ? src.displayWidth : src.width, sh = 'displayHeight' in src ? src.displayHeight : src.height;
  if (canvas.width !== sw || canvas.height !== sh) { canvas.width = sw; canvas.height = sh; }
  ctx.drawImage(src, 0, 0);
  const s = get();
  if (!s.hasFrame || s.frame?.w !== w || s.frame?.h !== h) set({ hasFrame: true, frame: { w, h } });
}

function decodeVideo(key: boolean, data: Uint8Array, w: number, h: number) {
  if (!VIDEO_OK) return;
  if (!decoder || decoder.state === 'closed') {
    decoder = new VideoDecoder({
      output: f => { draw(f, videoSize.w, videoSize.h); f.close(); },
      error: () => { decoder = null; needKey = true; send({ t: 'keyframe' }); },
    });
    decoder.configure({ codec: 'avc1.42E033', optimizeForLatency: true });
    needKey = true;
  }
  if (needKey && !key) return;
  needKey = false;
  videoSize = { w, h };
  // a backed-up decoder means we're behind: drop to the next keyframe
  if (decoder.decodeQueueSize > 6 && !key) { needKey = true; return; }
  decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: performance.now() * 1000, data }));
}

export function resetVideo() {
  needKey = true;
  if (decoder && decoder.state !== 'closed') { decoder.reset(); decoder.close(); }
  decoder = null;
}

// ---------- actions ----------
export function setMode(mode: StreamMode) {
  if (mode === get().mode) return;
  set({ mode, hasFrame: false });
  prefs.set('mode', mode);
  resetVideo();
  send({ t: 'mode', mode });
}

export function switchWorkspace(name: string) {
  if (name === get().ws) return;
  set({ ws: name, wsState: 'waking', tabs: [], tab: null, page: blankPage, hasFrame: false, thumbs: {} });
  resetVideo();
  send({ t: 'workspace', name });
}

export function viewTab(id: string) {
  set({ view: 'browser' });
  writeHash();
  if (id !== get().tab) send({ t: 'view', id });
}

export function setView(view: 'browser' | 'overview') {
  set({ view });
  send({ t: 'thumbs', on: view === 'overview' });
  writeHash();
}

export function toggleActivity(open = !get().activityOpen) {
  set({ activityOpen: open, ...(open && { unseenActivity: 0 }) });
  prefs.set('activityOpen', open);
}

export function saveDownload(id: string) {
  const a = document.createElement('a');
  a.href = `/api/downloads/${encodeURIComponent(get().ws || '')}/${id}`;
  a.download = '';
  a.click();
}

export async function uploadFiles(files: File[]): Promise<string[]> {
  const ws = encodeURIComponent(get().ws || '');
  return Promise.all(files.map(async f => {
    const r = await fetch(`/api/upload?workspace=${ws}`, { method: 'POST', body: f, headers: { 'x-filename': encodeURIComponent(f.name) } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `upload failed (${r.status})`);
    return (await r.json()).id as string;
  }));
}

export function navigate(url: string) {
  send({ t: 'nav', url });
}

// recent addresses for the start page and palette (this browser only)
export interface Recent { url: string; title: string; at: number }
function rememberUrl(url: string, title: string) {
  if (!/^https?:/.test(url)) return;
  const list = prefs.get<Recent[]>('recent', []).filter(r => r.url !== url);
  list.unshift({ url, title, at: Date.now() });
  prefs.set('recent', list.slice(0, 24));
}
export const recentUrls = () => prefs.get<Recent[]>('recent', []);

// ---------- lifecycle ----------
export function startConnection() {
  const v = readHash();
  set({ view: v.view });
  connect();
  setInterval(() => send({ t: 'ping', ts: performance.now() }), 2000);
  document.addEventListener('visibilitychange', () => send({ t: 'visible', on: !document.hidden }));
  window.addEventListener('hashchange', () => {
    const h = readHash();
    if (h.ws && h.ws !== get().ws) switchWorkspace(h.ws);
    if (h.view !== get().view) setView(h.view);
  });
}
