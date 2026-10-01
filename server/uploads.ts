// Files you pick in the viewer for a page's <input type=file>. They're stored
// in the workspace folder and handed to Chrome by path; old ones are removed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Manager } from './workspaces.js';

const MAX_BYTES = 200 << 20;
const KEEP_MS = 24 * 3600e3;

export class Uploads {
  private files = new Map<string, { path: string; workspace: string; at: number }>();
  private timer: NodeJS.Timeout;

  constructor(private manager: Manager) {
    for (const w of manager.all.values()) fs.rmSync(path.join(w.dir, 'uploads'), { recursive: true, force: true });
    this.timer = setInterval(() => this.prune(), 3600e3);
    this.timer.unref();
  }

  async receive(req: IncomingMessage, workspace: string, name: string): Promise<string> {
    const w = this.manager.get(workspace, { create: false });
    if (!w) throw new Error('no such workspace');
    const id = crypto.randomBytes(9).toString('base64url');
    const safe = path.basename(name).replace(/[\0/\\]/g, '_').slice(0, 200) || 'file';
    const dir = path.join(w.dir, 'uploads', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safe);
    await new Promise<void>((ok, fail) => {
      let size = 0;
      const out = fs.createWriteStream(file);
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); out.destroy(); fail(new Error('file is larger than 200 MB')); }
      });
      req.pipe(out);
      out.on('finish', ok);
      out.on('error', fail);
      req.on('error', fail);
    });
    this.files.set(id, { path: file, workspace, at: Date.now() });
    return id;
  }

  path(id: string, workspace: string) {
    const f = this.files.get(id);
    return f && f.workspace === workspace ? f.path : null;
  }

  private prune() {
    for (const [id, f] of this.files) if (Date.now() - f.at > KEEP_MS) {
      fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
      this.files.delete(id);
    }
  }
}
