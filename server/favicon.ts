// Tab icons for the sidebar: the site's /favicon.ico, fetched by the server
// (the same machine that is browsing the site anyway) and cached in memory.
const cache = new Map<string, { at: number; icon: { type: string; body: Buffer } | null }>();
const TTL = 6 * 3600e3, MAX = 500, LIMIT = 256 << 10;

export async function favicon(pageUrl: string) {
  let origin: string;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    origin = u.origin;
  } catch { return null; }
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL) return hit.icon;
  let icon: { type: string; body: Buffer } | null = null;
  try {
    const res = await fetch(origin + '/favicon.ico', { signal: AbortSignal.timeout(4000), redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 ridealong' } });
    const type = res.headers.get('content-type') || '';
    if (res.ok && /^image\//.test(type)) {
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length && body.length < LIMIT) icon = { type, body };
    }
  } catch {}
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(origin, { at: Date.now(), icon });
  return icon;
}
