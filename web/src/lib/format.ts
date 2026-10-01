// Display helpers shared by the components.

// Agents keep the same colour everywhere: sidebar, overview, activity, stage ring.
const HUES = [25, 285, 175, 340, 225, 85, 145, 310, 200, 55];
export function agentHue(name: string) {
  let h = 7;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
export const agentColor = (name: string) => `oklch(0.7 0.16 ${agentHue(name)})`;
export const agentTint = (name: string) => `oklch(0.7 0.16 ${agentHue(name)} / 0.16)`;

export function initials(name: string) {
  const parts = name.split(/[-_.\s]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase();
}

export function host(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : url;
  } catch { return url; }
}

export function splitUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { secure: false, host: url, rest: '' };
    const rest = (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash;
    return { secure: u.protocol === 'https:', host: u.host.replace(/^www\./, ''), rest };
  } catch { return { secure: false, host: url, rest: '' }; }
}

export const isBlank = (url?: string) => !url || url === 'about:blank' || /^chrome:\/\/(newtab|new-tab-page)/.test(url);

export function tabTitle(t: { title?: string; url?: string }) {
  if (isBlank(t.url)) return 'New tab';
  return t.title && t.title !== t.url ? t.title : host(t.url || '');
}

export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(at).toLocaleDateString();
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.ceil(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
