// The viewer's web server: the React app, a password login, a small API for
// favicons, uploads and downloads, and the /ws socket each viewer streams over.
// Password-gated; meant to sit behind a tunnel or reverse proxy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Config } from './config.js';
import type { Manager } from './workspaces.js';
import { ViewerSession } from './session.js';
import { Uploads } from './uploads.js';
import { videoSupported } from './video.js';
import { favicon } from './favicon.js';
import { VERSION } from './version.js';
import type { Boot } from '../shared/protocol.js';

const GLOBE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8b8b95" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

export function start({ cfg, manager }: { cfg: Config; manager: Manager }): Promise<http.Server> {
  const secret = crypto.createHash('sha256').update('tabkennel:' + cfg.password).digest('hex');
  const authed = (req: http.IncomingMessage) => (req.headers.cookie || '').split(/;\s*/).includes('tk=' + secret);
  const secure = (req: http.IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || /"https"/.test(String(req.headers['cf-visitor'] || ''));
  const sameOrigin = (req: http.IncomingMessage) => {
    try { return !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const uploads = new Uploads(manager);

  const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer, extra: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (res: http.ServerResponse, v: unknown, status = 200, extra: http.OutgoingHttpHeaders = {}) =>
    send(res, status, 'application/json', JSON.stringify(v), extra);

  const staticFile = (res: http.ServerResponse, url: string) => {
    const rel = path.normalize(decodeURIComponent(url)).replace(/^(\.\.[/\\])+/, '');
    let file = path.join(WEB, rel);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
    if (!fs.existsSync(file)) return send(res, 500, 'text/plain', 'The web UI is not built. Run `npm run build`.');
    const hashed = rel.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
      ...(file.endsWith('.html') && { 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }),
    });
    fs.createReadStream(file).pipe(res);
  };

  const readBody = (req: http.IncomingMessage, limit = 4096) => new Promise<string>((ok, fail) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) { req.destroy(); fail(new Error('too large')); } });
    req.on('end', () => ok(body));
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const p = u.pathname;
    try {
      if (req.method === 'POST' && p === '/login') {
        const body = await readBody(req);
        const isJson = /json/.test(String(req.headers['content-type']));
        const given = Buffer.from(String((isJson ? JSON.parse(body || '{}').password : new URLSearchParams(body).get('password')) || ''));
        const want = Buffer.from(String(cfg.password));
        const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
        const cookie = ok ? { 'set-cookie': `tk=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure(req) ? '; Secure' : ''}` } : {};
        // failed guesses are slow on purpose
        await new Promise(r => setTimeout(r, ok ? 0 : 800));
        return isJson ? json(res, { ok }, ok ? 200 : 401, cookie) : send(res, 303, 'text/plain', '', { location: ok ? '/' : '/?wrong', ...cookie });
      }
      if (p === '/logout') return send(res, 303, 'text/plain', '', { location: '/', 'set-cookie': 'tk=; Path=/; Max-Age=0' });
      if (p === '/healthz') return send(res, 200, 'text/plain', 'ok');
      if (p === '/api/boot') {
        const boot: Boot = { authed: authed(req), version: VERSION, agentPort: cfg.agentPort, idleMinutes: cfg.idleMinutes, video: videoSupported() };
        return json(res, boot);
      }
      if (p.startsWith('/api/')) {
        if (!authed(req)) return json(res, { error: 'sign in first' }, 401);
        if (req.method !== 'GET' && !sameOrigin(req)) return json(res, { error: 'cross-origin request refused' }, 403);
        if (p === '/api/favicon') {
          const icon = await favicon(u.searchParams.get('url') || '');
          // no icon: a neutral globe, so the page doesn't log a failed request per tab
          return icon ? send(res, 200, icon.type, icon.body, { 'cache-control': 'private, max-age=86400' })
            : send(res, 200, 'image/svg+xml', GLOBE, { 'cache-control': 'private, max-age=3600' });
        }
        if (p === '/api/upload' && req.method === 'POST') {
          const name = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
          return json(res, { id: await uploads.receive(req, u.searchParams.get('workspace') || '', name) });
        }
        const dl = p.match(/^\/api\/downloads\/([^/]+)\/([\w-]+)$/);
        if (dl) {
          const w = manager.get(dl[1], { create: false });
          const d = w?.downloads.get(dl[2]);
          if (!w || !d) return json(res, { error: 'not found' }, 404);
          if (req.method === 'DELETE') { w.downloads.remove(d.id); w.emit('downloads'); return json(res, { ok: true }); }
          const file = w.downloads.path(d.id);
          if (!fs.existsSync(file)) return json(res, { error: 'the file is gone' }, 404);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': fs.statSync(file).size,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(d.name)}`,
            'cache-control': 'no-store',
          });
          return void fs.createReadStream(file).pipe(res);
        }
        return json(res, { error: 'not found' }, 404);
      }
      staticFile(res, p);
    } catch (e) {
      if (!res.headersSent) json(res, { error: (e as Error).message }, 500);
      else res.destroy();
    }
  });

  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 1 << 20,
    verifyClient: ({ req }: { req: http.IncomingMessage }) => authed(req) && sameOrigin(req),
  });
  wss.on('connection', ws => new ViewerSession(ws, cfg, manager, uploads));

  return new Promise((ok, fail) => { server.once('error', fail); server.listen(cfg.viewerPort, cfg.bind, () => ok(server)); });
}
