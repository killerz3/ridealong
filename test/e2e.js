// End-to-end: real Chrome, real agents (puppeteer), real viewer socket.
//   npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const puppeteer = require('puppeteer-core');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tabkennel-test-'));
const VP = 28000 + Math.floor(Math.random() * 1000), AP = VP + 1000;
const env = { ...process.env, TABKENNEL_HOME: home, TABKENNEL_PASSWORD: 'pw', TABKENNEL_PORT: VP, TABKENNEL_AGENT_PORT: AP, TABKENNEL_IDLE_MINUTES: '0.1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (p, method = 'GET') => (await fetch(`http://127.0.0.1:${AP}${p}`, { method })).json();
const ws = (name) => api('/api/workspaces').then(l => l.find(w => w.name === name));
const until = async (fn, ms = 15000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await Promise.resolve().then(fn).catch(() => null); if (v) return v; await sleep(200); }
  throw new Error('timed out waiting for ' + what);
};
const agent = (w, name) => puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${AP}/${w ? w + '/' : ''}${name}/devtools/browser`, defaultViewport: null });
const ANIM = 'data:text/html,<title>anim</title><body><div id=d style="width:80px;height:80px;background:red"></div><script>let i=0;setInterval(()=>{d.style.marginLeft=(i++%25200)+"px"},16)</script>';

const openViewers = [];
async function viewer(workspace, mode = 'jpeg') {
  const r = await fetch(`http://127.0.0.1:${VP}/login`, { method: 'POST', body: 'password=pw', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const sock = new WebSocket(`ws://127.0.0.1:${VP}/ws`, { headers: { cookie } });
  const v = { sock, json: [], frames: [], send: m => sock.send(JSON.stringify(m)) };
  openViewers.push(sock);
  sock.on('message', (d, bin) => {
    if (!bin) return v.json.push(JSON.parse(d));
    const b = Buffer.from(d);
    const f = { type: b[0], seq: b.readUInt32LE(4), w: b.readFloatLE(8), h: b.readFloatLE(12), size: b.length - 16, at: Date.now() };
    v.frames.push(f);
    if (!v.noAck) v.send({ t: 'ack', seq: f.seq });
  });
  await new Promise((ok, no) => { sock.once('open', ok); sock.once('error', no); });
  v.send({ t: 'hello', workspace, mode, w: 1200, h: 800, dpr: 1 });
  v.last = t => [...v.json].reverse().find(m => m.t === t);
  return v;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
let server;

test('login rejects a wrong password', async () => {
  const r = await fetch(`http://127.0.0.1:${VP}/login`, { method: 'POST', body: 'password=nope', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(r.headers.get('location'), '/?wrong');
  assert.equal(r.headers.get('set-cookie'), null);
  const page = await (await fetch(`http://127.0.0.1:${VP}/`)).text();
  assert.match(page, /Sign in/);
});

let alice, bob, carol, aliceTab;
test('an agent connecting to a new workspace creates and wakes it', async () => {
  assert.equal(await ws('work'), undefined);
  alice = await agent('work', 'alice');
  assert.equal((await ws('work')).state, 'awake');
  assert.deepEqual((await ws('work')).agents, ['alice']);
  aliceTab = await alice.newPage();
  await aliceTab.goto('data:text/html,<title>alice-page</title>hello');
  assert.equal(await aliceTab.title(), 'alice-page');
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
  assert.equal((await ws('default')).state, 'awake');
  const cp = await carol.newPage();
  await cp.goto(`http://127.0.0.1:${VP}/healthz`);
  assert.equal(await cp.evaluate(() => document.cookie), '');
  await cp.close();
});

test('viewer sees all tabs labelled by owner, and streams JPEG frames with backpressure', async () => {
  await aliceTab.goto(ANIM);
  const v = await viewer('work');
  await until(() => v.last('state') && v.last('state').state === 'awake', 15000, 'viewer awake');
  const tabs = await until(() => { const t = v.last('tabs'); return t && t.tabs.some(x => x.owner === 'alice') && t.tabs.some(x => x.owner === 'bob') && t; }, 5000, 'tabs');
  const at = tabs.tabs.find(t => t.owner === 'alice');
  v.send({ t: 'view', id: at.id });
  await sleep(2500);
  const jpeg = v.frames.filter(f => f.type === 1);
  assert.ok(jpeg.length > 20, `expected steady frames, got ${jpeg.length}`);
  assert.ok(jpeg.at(-1).w > 100, 'frames carry page size');
  // stop acking: the server must stop sending after 2 unacked frames
  v.noAck = true; await sleep(300);
  const before = v.frames.length; await sleep(1000);
  assert.ok(v.frames.length - before <= 2, `sent ${v.frames.length - before} frames without acks`);
  v.sock.close();
});

test('video mode streams H.264 starting with a keyframe', async () => {
  const v = await viewer('work', 'video');
  await until(() => v.last('state') && v.last('state').state === 'awake', 15000, 'viewer awake');
  const at = (await until(() => v.last('tabs'), 5000, 'tabs')).tabs.find(t => t.owner === 'alice');
  v.send({ t: 'view', id: at.id });
  await until(() => v.frames.some(f => f.type === 2), 8000, 'keyframe');
  const t0 = Date.now(); await sleep(2000);
  const video = v.frames.filter(f => f.type === 2 || f.type === 3);
  const recent = video.filter(f => f.at >= t0);
  assert.equal(video.find(f => f.type === 2 || f.type === 3).type, 2, 'first video frame is a keyframe');
  assert.ok(recent.length >= 20, `expected ~30 fps, got ${recent.length / 2}/s`);
  assert.ok(!v.json.some(m => m.t === 'mode' && m.mode === 'jpeg'), 'video mode must not fall back: ' + JSON.stringify(v.json.filter(m => m.t === 'mode')));
  v.sock.close();
});

test('JS dialogs reach the viewer and can be answered', async () => {
  const v = await viewer('work');
  const at = (await until(() => v.last('tabs') && v.last('tabs').tabs.find(t => t.owner === 'alice'), 15000, 'tabs'));
  v.send({ t: 'view', id: at.id });
  await until(() => v.last('view') && v.last('view').id === at.id, 5000, 'view');
  const answer = aliceTab.evaluate(() => confirm('really?'));
  const d = await until(() => v.last('dialog'), 5000, 'dialog');
  assert.equal(d.message, 'really?');
  v.send({ t: 'dialog', accept: true });
  assert.equal(await answer, true);
  v.sock.close();
});

test('sleeping disconnects agents, frees Chrome, and restores tabs + ownership on wake', async () => {
  // Chrome restores real URLs, not data: ones
  await aliceTab.goto(`http://127.0.0.1:${VP}/healthz?alice`);
  await sleep(300);
  const closed = new Promise(r => alice.once('disconnected', r));
  await api('/api/workspaces/work/sleep', 'POST');
  await closed;
  assert.equal((await ws('work')).state, 'asleep');
  alice = await agent('work', 'alice');
  const urls = await until(async () => { const u = (await alice.pages()).map(p => p.url()); return u.some(x => x.endsWith('?alice')) && u; }, 10000, 'restored tab');
  assert.equal(urls.length, 1, 'alice gets back exactly her tab: ' + urls);
});

test('an unused workspace goes to sleep by itself', async () => {
  await alice.disconnect();
  if (bob.connected) await bob.disconnect().catch(() => {});
  // idleMinutes is 0.1 (6 s) in this test; the check runs every 15 s
  await until(async () => (await ws('work')).state === 'asleep', 40000, 'idle sleep');
});

test('a viewer holding a workspace keeps it awake', async () => {
  const v = await viewer('work');
  await until(() => v.last('state') && v.last('state').state === 'awake', 15000, 'awake');
  await sleep(22000);
  assert.equal((await ws('work')).state, 'awake');
  v.send({ t: 'visible', on: false });
  await until(async () => (await ws('work')).state === 'asleep', 40000, 'sleep after the viewer hides');
  v.sock.close();
});

const mainChromes = profile => fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).filter(pid => {
  try { const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); return /[\0 ]$|^$/.test(c.split(`--user-data-dir=${profile}`)[1]?.charAt(0) ?? 'x') && !c.includes('--type='); } catch { return false; }
});

const rssMB = () => +fs.readFileSync(`/proc/${server.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1] / 1024;
test('a viewer leaving while its tab closes does not leak', async () => {
  const a = await agent('leak', 'erin');
  const p = await a.newPage(); await p.goto(ANIM);
  const v = await viewer('leak');
  const tab = await until(() => v.last('tabs') && v.last('tabs').tabs.find(t => t.owner === 'erin'), 15000, 'tab');
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
  server.kill('SIGKILL');
  await new Promise(r => server.once('exit', r));
  assert.equal(mainChromes(profile).length, 1, 'the orphaned Chrome is still running');
  await startServer();
  const b = await agent('crash', 'dave');
  assert.equal(mainChromes(profile).length, 1, 'exactly one Chrome on the profile');
  await b.disconnect();
});

async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'tabkennel.js'), 'start'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = ''; server.stdout.on('data', d => { log += d; if (process.env.VERBOSE) process.stdout.write(d); });
  await until(() => log.includes('tabkennel is running'), 10000, 'server start');
}

(async () => {
  await startServer();
  let failed = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try { await t.fn(); console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`); } catch (e) { failed++; console.log(`  ✗ ${t.name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); }
    openViewers.splice(0).forEach(s => s.close());
  }
  server.kill('SIGTERM');
  await new Promise(r => server.once('exit', r));
  fs.rmSync(home, { recursive: true, force: true });
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
