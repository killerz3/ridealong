// Files downloaded in a workspace's Chrome. Chrome saves them under their
// download id (allowAndName); this keeps the real names so the viewer can
// hand them to you. Only the most recent ones are kept.
import fs from 'node:fs';
import path from 'node:path';
import type { Download } from '../shared/protocol.js';

const KEEP = 30;

export class Downloads {
  items: Download[] = [];
  private file: string;

  constructor(public dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'index.json');
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    // anything in progress when Chrome stopped didn't finish
    for (const d of this.items) if (d.state === 'inProgress') d.state = 'canceled';
  }

  begin(d: { id: string; name: string; url: string }) {
    this.items.unshift({ ...d, state: 'inProgress', received: 0, total: 0, at: Date.now() });
    for (const old of this.items.splice(KEEP)) fs.rmSync(this.path(old.id), { force: true });
    this.save();
  }

  progress(p: { id: string; state: Download['state']; received: number; total: number }) {
    const d = this.items.find(i => i.id === p.id);
    if (!d) return null;
    Object.assign(d, { state: p.state, received: p.received, total: p.total });
    if (p.state !== 'inProgress') this.save();
    return d;
  }

  get(id: string) { return this.items.find(i => i.id === id); }
  path(id: string) { return path.join(this.dir, id.replace(/[^\w-]/g, '')); }

  remove(id: string) {
    this.items = this.items.filter(i => i.id !== id);
    fs.rmSync(this.path(id), { force: true });
    this.save();
  }

  private save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.items)); } catch {}
  }
}
