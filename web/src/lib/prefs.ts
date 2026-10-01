// Small per-browser preferences. Storage can be unavailable (private mode,
// blocked site data), so every access is guarded.
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem('tk.' + key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch { return fallback; }
  },
  set(key: string, value: unknown) {
    try { localStorage.setItem('tk.' + key, JSON.stringify(value)); } catch {}
  },
};
