// End-to-end: real Chrome, real agents (puppeteer), real viewer socket.
//   npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import puppeteer, { type Browser } from 'puppeteer-core';
import type { ClientMsg, ServerMsg, WorkspaceInfo } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ridealong-test-'));
const VP = 28000 + Math.floor(Math.random() * 1000), AP = VP + 1000;
const env = { ...process.env, RIDEALONG_HOME: home, RIDEALONG_PASSWORD: 'pw', RIDEALONG_PORT: String(VP), RIDEALONG_AGENT_PORT: String(AP), RIDEALONG_IDLE_MINUTES: '0.1' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const api = async (p: string, method = 'GET') => (await fetch(`http://127.0.0.1:${AP}${p}`, { method })).json();
const ws = (name: string): Promise<WorkspaceInfo | undefined> => api('/api/workspaces').then((l: WorkspaceInfo[]) => l.find(w => w.name === name));
type Truthy<T> = Exclude<T, false | null | undefined | '' | 0>;
async function until<T>(fn: () => T | Promise<T>, ms = 15000, what = 'condition'): Promise<Truthy<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v as Truthy<T>;
    await sleep(200);
  }
  throw new Error('timed out waiting for ' + what);
}
const agent = (w: string | null, name: string) => puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${AP}/${w ? w + '/' : ''}${name}/devtools/browser`, defaultViewport: null });
const ANIM = 'data:text/html,<title>anim</title><body><div id=d style="width:80px;height:80px;background:red"></div><script>let i=0;setInterval(()=>{d.style.marginLeft=(i++%25200)+"px"},16)</script>';

// a little site for downloads, uploads and favicons
const ICON = Buffer.from('AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAD/AAD/AAAAAA==', 'base64');
const site = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/x-icon' }); return res.end(ICON); }
  if (req.url === '/report.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' }); return res.end('a,b\n1,2\n'); }
  if (req.url === '/upload') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>upload</title><input type=file id=f style="position:fixed;left:0;top:0;width:300px;height:100px">'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>site ${req.url}</title>hello`);
});
await new Promise<void>(r => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

interface Frame { type: number; seq: number; w: number; h: number; size: number; at: number }
interface Viewer {
  sock: WebSocket; cookie: string; json: ServerMsg[]; frames: Frame[]; noAck?: boolean;
  send(m: ClientMsg): void;
  last<K extends ServerMsg['t']>(t: K): Extract<ServerMsg, { t: K }> | undefined;
  all<K extends ServerMsg['t']>(t: K): Extract<ServerMsg, { t: K }>[];
}

const openViewers: WebSocket[] = [];
async function login() {
  const r = await fetch(`http://127.0.0.1:${VP}/login`, { method: 'POST', body: 'password=pw', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}
async function viewer(workspace: string, mode: 'jpeg' | 'video' = 'jpeg'): Promise<Viewer> {
  const cookie = await login();
  const sock = new WebSocket(`ws://127.0.0.1:${VP}/ws`, { headers: { cookie } });
  const v: Viewer = {
    sock, cookie, json: [], frames: [],
    send: m => sock.send(JSON.stringify(m)),
    last: t => [...v.json].reverse().find(m => m.t === t) as any,
    all: t => v.json.filter(m => m.t === t) as any,
  };
  openViewers.push(sock);
  sock.on('message', (d, bin) => {
    if (!bin) return void v.json.push(JSON.parse(String(d)));
    const b = Buffer.from(d as Buffer);
    const f = { type: b[0], seq: b.readUInt32LE(4), w: b.readFloatLE(8), h: b.readFloatLE(12), size: b.length - 16, at: Date.now() };
    v.frames.push(f);
    if (!v.noAck) v.send({ t: 'ack', seq: f.seq });
  });
  await new Promise((ok, no) => { sock.once('open', ok); sock.once('error', no); });
  v.send({ t: 'hello', workspace, mode, visible: true, w: 1200, h: 800, dpr: 1, mobile: false });
  return v;
}
const awake = (v: Viewer) => until(() => v.last('state')?.state === 'awake', 15000, 'viewer awake');

const tests: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });
let server!: ChildProcess;

test('the app loads for anyone; the API and socket need the password', async () => {
  const page = await (await fetch(`http://127.0.0.1:${VP}/`)).text();
  assert.match(page, /<div id="root">/);
  assert.equal((await (await fetch(`http://127.0.0.1:${VP}/api/boot`)).json()).authed, false);
  assert.equal((await fetch(`http://127.0.0.1:${VP}/api/favicon?url=x`)).status, 401);
  const r = await fetch(`http://127.0.0.1:${VP}/login`, { method: 'POST', body: JSON.stringify({ password: 'nope' }), headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('set-cookie'), null);
  const cookie = await login();
  assert.equal((await (await fetch(`http://127.0.0.1:${VP}/api/boot`, { headers: { cookie } })).json()).authed, true);
});

let alice: Browser, bob: Browser, carol: Browser;
let aliceTab: Awaited<ReturnType<Browser['newPage']>>;
test('an agent connecting to a new workspace creates and wakes it', async () => {
  assert.equal(await ws('work'), undefined);
  alice = await agent('work', 'alice');
  assert.equal((await ws('work'))!.state, 'awake');
  assert.deepEqual((await ws('work'))!.agents.map(a => a.name), ['alice']);
  aliceTab = await alice.newPage();
  await aliceTab.goto('data:text/html,<title>alice-page</title>hello');
  assert.equal(await aliceTab.title(), 'alice-page');
});

test('pages do not see an automated browser (Google refuses sign-in if they do)', async () => {
  const p = await alice.newPage();
  assert.equal(await p.evaluate(() => navigator.webdriver), false);
  await p.close();
});

test('agents only see their own tabs', async () => {
  bob = await agent('work', 'bob');
  const bobPages = await bob.pages();
  assert.ok(!(await Promise.all(bobPages.map(p => p.title()))).includes('alice-page'), 'bob must not see alice\'s tab');
  const bp = await bob.newPage(); await bp.goto('data:text/html,<title>bob-page</title>');
  const titles = await Promise.all((await alice.pages()).map(p => p.title()));
  assert.ok(titles.includes('alice-page') && !titles.includes('bob-page'));
});

test('workspaces have separate cookies; legacy /<agent>/ URL uses default', async () => {
  await aliceTab.goto(`http://127.0.0.1:${VP}/healthz`);
  await aliceTab.evaluate(() => { document.cookie = 'who=work; path=/'; });
  carol = await agent(null, 'carol');
  assert.equal((await ws('default'))!.state, 'awake');
  const cp = await carol.newPage();
  await cp.goto(`http://127.0.0.1:${VP}/healthz`);
  assert.equal(await cp.evaluate(() => document.cookie), '');
  await cp.close();
});

test('viewer sees all tabs labelled by owner, and streams JPEG frames with backpressure', async () => {
  await aliceTab.goto(ANIM);
  const v = await viewer('work');
  await awake(v);
  const tabs = await until(() => { const t = v.last('tabs'); return t && t.tabs.some(x => x.owner === 'alice') && t.tabs.some(x => x.owner === 'bob') && t; }, 5000, 'tabs');
  const at = tabs.tabs.find(t => t.owner === 'alice')!;
  v.send({ t: 'view', id: at.id });
  await sleep(2500);
  const jpeg = v.frames.filter(f => f.type === 1);
  assert.ok(jpeg.length > 20, `expected steady frames, got ${jpeg.length}`);
  assert.ok(jpeg.at(-1)!.w > 100, 'frames carry page size');
  // stop acking: the server must stop sending after 2 unacked frames
  v.noAck = true; await sleep(300);
  const before = v.frames.length; await sleep(1000);
  assert.ok(v.frames.length - before <= 2, `sent ${v.frames.length - before} frames without acks`);
  v.sock.close();
});

test('video mode streams H.264 starting with a keyframe', async () => {
  const v = await viewer('work', 'video');
  await awake(v);
  const at = (await until(() => v.last('tabs'), 5000, 'tabs')).tabs.find(t => t.owner === 'alice')!;
  v.send({ t: 'view', id: at.id });
  await until(() => v.frames.some(f => f.type === 2), 8000, 'keyframe');
  const t0 = Date.now(); await sleep(2000);
  const video = v.frames.filter(f => f.type === 2 || f.type === 3);
  const recent = video.filter(f => f.at >= t0);
  assert.equal(video[0].type, 2, 'first video frame is a keyframe');
  assert.ok(recent.length >= 20, `expected ~30 fps, got ${recent.length / 2}/s`);
  assert.ok(!v.all('mode').some(m => m.mode === 'jpeg'), 'video mode must not fall back: ' + JSON.stringify(v.all('mode')));
  v.sock.close();
});

test('JS dialogs reach the viewer and can be answered', async () => {
  const v = await viewer('work');
  const at = await until(() => v.last('tabs')?.tabs.find(t => t.owner === 'alice'), 15000, 'tabs');
  v.send({ t: 'view', id: at.id });
  await until(() => v.last('view')?.id === at.id, 5000, 'view');
  const answer = aliceTab.evaluate(() => confirm('really?'));
  const d = await until(() => v.last('dialog'), 5000, 'dialog');
  assert.ok(!('closed' in d) && d.message === 'really?');
  v.send({ t: 'dialog', accept: true });
  assert.equal(await answer, true);
  v.sock.close();
});

test('the activity feed shows what agents do, live', async () => {
  const v = await viewer('work');
  await awake(v);
  const first = v.last('activity')!;
  assert.ok(first.reset && first.items.some(i => i.kind === 'connect' && i.agent === 'alice'), 'history includes alice connecting');
  await aliceTab.goto(`${SITE}/somewhere`);
  await until(() => v.all('activity').some(a => a.items.some(i => i.kind === 'navigate' && i.agent === 'alice' && i.url === `${SITE}/somewhere`)), 5000, 'navigate event');
  const p = await bob.newPage();
  await until(() => v.all('activity').some(a => a.items.some(i => i.kind === 'open' && i.agent === 'bob')), 5000, 'open event');
  await p.close();
  await until(() => v.all('activity').some(a => a.items.some(i => i.kind === 'close' && i.agent === 'bob')), 5000, 'close event');
  v.sock.close();
});

test('the overview gets a thumbnail of every tab', async () => {
  const v = await viewer('work');
  await awake(v);
  const tabs = (await until(() => v.last('tabs'), 5000, 'tabs')).tabs;
  v.send({ t: 'thumbs', on: true });
  const ids = await until(() => { const got = new Set(v.all('thumb').map(t => t.id)); return tabs.every(t => got.has(t.id)) && got; }, 15000, 'thumbnails');
  assert.equal(ids.size, tabs.length);
  const jpeg = Buffer.from(v.last('thumb')!.data, 'base64');
  assert.equal(jpeg[0], 0xff, 'thumbnails are JPEG');
  v.sock.close();
});

test('downloads land in the workspace and can be fetched by the viewer', async () => {
  const v = await viewer('work');
  await awake(v);
  await aliceTab.goto(`${SITE}/report.csv`).catch(() => {}); // a download aborts the navigation
  const d = await until(() => v.last('downloads')?.items.find(i => i.name === 'report.csv' && i.state === 'completed'), 10000, 'download');
  assert.ok(v.all('activity').some(a => a.items.some(i => i.kind === 'download' && i.agent === 'alice')), 'download shows in activity');
  const r = await fetch(`http://127.0.0.1:${VP}/api/downloads/work/${d.id}`, { headers: { cookie: v.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition')!, /report\.csv/);
  assert.equal(await r.text(), 'a,b\n1,2\n');
  v.sock.close();
});

test('a page asking for a file gets the one you upload', async () => {
  await aliceTab.goto(`${SITE}/upload`);
  const v = await viewer('work');
  const at = await until(() => v.last('tabs')?.tabs.find(t => t.owner === 'alice' && t.url.endsWith('/upload')), 15000, 'upload tab');
  v.send({ t: 'view', id: at.id });
  await until(() => v.last('view')?.id === at.id, 5000, 'view');
  const n = v.frames.length;
  await until(() => v.frames.length > n, 5000, 'frames of the upload page');
  // a real click on the file input, as you would do in the viewer
  v.send({ t: 'mouse', type: 'mousePressed', x: 50, y: 50, button: 'left', buttons: 1, clickCount: 1 });
  v.send({ t: 'mouse', type: 'mouseReleased', x: 50, y: 50, button: 'left', buttons: 0, clickCount: 1 });
  const chooser = await until(() => v.last('filechooser'), 5000, 'file chooser');
  assert.equal(chooser.multiple, false);
  const up = await fetch(`http://127.0.0.1:${VP}/api/upload?workspace=work`, { method: 'POST', body: 'hello file', headers: { cookie: v.cookie, 'x-filename': encodeURIComponent('notes.txt') } });
  const { id } = await up.json() as { id: string };
  v.send({ t: 'files', ids: [id] });
  const got = await until(() => aliceTab.evaluate(async () => {
    const f = (document.getElementById('f') as HTMLInputElement).files?.[0];
    return f && `${f.name}:${await f.text()}`;
  }), 5000, 'file set on the input');
  assert.equal(got, 'notes.txt:hello file');
  v.sock.close();
});

test('blocking an agent disconnects it and refuses it until unblocked', async () => {
  const v = await viewer('work');
  await awake(v);
  const gone = new Promise(r => bob.once('disconnected', r));
  v.send({ t: 'agent', name: 'bob', action: 'block' });
  await gone;
  await until(async () => (await ws('work'))!.blocked.includes('bob'), 3000, 'blocked');
  await assert.rejects(agent('work', 'bob'), 'a blocked agent cannot connect');
  v.send({ t: 'agent', name: 'bob', action: 'unblock' });
  await until(async () => !(await ws('work'))!.blocked.length, 3000, 'unblocked');
  bob = await agent('work', 'bob');
  v.sock.close();
});

test('awake workspaces report their memory; tab icons come from the site', async () => {
  const mb = await until(async () => (await ws('work'))!.memoryMB, 20000, 'memory figure');
  assert.ok(mb > 50 && mb < 5000, `memory ${mb} MB`);
  const cookie = await login();
  const r = await fetch(`http://127.0.0.1:${VP}/api/favicon?url=${encodeURIComponent(SITE + '/x')}`, { headers: { cookie } });
  assert.equal(r.headers.get('content-type'), 'image/x-icon');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), ICON);
});

test('sleeping disconnects agents, frees Chrome, and restores tabs + ownership on wake', async () => {
  // Chrome restores real URLs, not data: ones
  await aliceTab.goto(`http://127.0.0.1:${VP}/healthz?alice`);
  await sleep(300);
  const closed = new Promise(r => alice.once('disconnected', r));
  await api('/api/workspaces/work/sleep', 'POST');
  await closed;
  assert.equal((await ws('work'))!.state, 'asleep');
  alice = await agent('work', 'alice');
  const urls = await until(async () => { const u = (await alice.pages()).map(p => p.url()); return u.some(x => x.endsWith('?alice')) && u; }, 10000, 'restored tab');
  assert.equal(urls.filter(u => u.endsWith('?alice')).length, 1, 'alice gets back her tab: ' + urls);
});

test('an unused workspace goes to sleep by itself', async () => {
  await alice.disconnect();
  if (bob.connected) await bob.disconnect().catch(() => {});
  // idleMinutes is 0.1 (6 s) in this test; the check runs every 15 s
  await until(async () => (await ws('work'))!.state === 'asleep', 40000, 'idle sleep');
});

test('a viewer holding a workspace keeps it awake', async () => {
  const v = await viewer('work');
  await awake(v);
  await sleep(22000);
  assert.equal((await ws('work'))!.state, 'awake');
  v.send({ t: 'visible', on: false });
  await until(async () => (await ws('work'))!.state === 'asleep', 40000, 'sleep after the viewer hides');
  v.sock.close();
});

const mainChromes = (profile: string) => fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).filter(pid => {
  try {
    const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /[\0 ]$|^$/.test(c.split(`--user-data-dir=${profile}`)[1]?.charAt(0) ?? 'x') && !c.includes('--type=');
  } catch { return false; }
});

const rssMB = () => +fs.readFileSync(`/proc/${server.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)![1] / 1024;
test('a viewer leaving while its tab closes does not leak', async () => {
  const a = await agent('leak', 'erin');
  const p = await a.newPage(); await p.goto(ANIM);
  const v = await viewer('leak');
  const tab = await until(() => v.last('tabs')?.tabs.find(t => t.owner === 'erin'), 15000, 'tab');
  v.send({ t: 'view', id: tab.id });
  await until(() => v.frames.length > 5, 5000, 'frames');
  const before = rssMB();
  v.sock.close(); await p.close();
  await sleep(6000);
  assert.ok(rssMB() - before < 40, `server memory grew ${Math.round(rssMB() - before)} MB`);
  await a.disconnect();
});

test('after a crash, restarting cleans up the old browser instead of doubling it', async () => {
  const a = await agent('crash', 'dave');
  const p = await a.newPage(); await p.goto(`http://127.0.0.1:${VP}/healthz?dave`);
  const profile = path.join(home, 'workspaces', 'crash', 'profile');
  assert.equal(mainChromes(profile).length, 1);
  await sleep(11000); // Chrome writes its session about every 10 s
  server.kill('SIGKILL');
  await new Promise(r => server.once('exit', r));
  assert.equal(mainChromes(profile).length, 1, 'the orphaned Chrome is still running');
  await startServer();
  assert.equal(mainChromes(profile).length, 0, 'startup stops browsers left by the crash');
  const b = await agent('crash', 'dave');
  assert.equal(mainChromes(profile).length, 1, 'exactly one Chrome on the profile');
  assert.ok((await b.pages()).some(p => p.url().endsWith('?dave')), 'tabs survive the crash');
  await b.disconnect();
});

async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'bin', 'ridealong.js'), 'start'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = '';
  server.stdout!.on('data', d => { log += d; if (process.env.VERBOSE) process.stdout.write(d); });
  await until(() => log.includes('ridealong is running'), 10000, 'server start');
}

await startServer();
let failed = 0;
const only = process.argv[2];
for (const t of tests) {
  if (only && !t.name.includes(only) && !/creates and wakes|own tabs/.test(t.name)) continue;
  const t0 = Date.now();
  try { await t.fn(); console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`); } catch (e) {
    failed++;
    console.log(`  ✗ ${t.name}\n    ${(e as Error).stack!.split('\n').slice(0, 3).join('\n    ')}`);
  }
  openViewers.splice(0).forEach(s => s.close());
}
server.kill('SIGTERM');
await new Promise(r => server.once('exit', r));
site.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
