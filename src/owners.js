// Which agent opened which tab, per workspace. Tab ids change when Chrome
// restores a session, so before a workspace sleeps we remember each agent tab
// by URL and hand it back to that agent when the restored tab reappears.
const fs = require('fs');

class Owners {
  constructor(file) {
    this.file = file;
    this.map = {};
    this.restore = []; // [{ url, owner }] waiting for their restored tab
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.owners) { this.map = d.owners; this.restore = d.restore || []; } else this.map = d;
    } catch {}
  }
  get(id) { return this.map[id]; }
  set(id, bot) { this.map[id] = bot; this.save(); }
  del(id) { delete this.map[id]; this.save(); }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.timer);
    try { fs.writeFileSync(this.file, JSON.stringify({ owners: this.map, restore: this.restore })); } catch {}
  }
  // pages: [{ id, url }] currently open
  snapshot(pages) {
    this.restore = pages.filter(p => this.map[p.id]).map(p => ({ url: p.url, owner: this.map[p.id] }));
    this.map = {};
    this.flush();
  }
  // a restored page appeared: claim it if an agent had a tab at this URL
  claim(id, url) {
    if (this.map[id] || !url) return;
    const i = this.restore.findIndex(r => r.url === url);
    if (i < 0) return;
    this.map[id] = this.restore[i].owner;
    this.restore.splice(i, 1);
    this.save();
  }
  dropRestore() { if (this.restore.length) { this.restore = []; this.save(); } }
}

module.exports = Owners;
