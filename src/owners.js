// Which agent opened which tab, per workspace. Tab ids change when Chrome
// restores a session, so before a workspace sleeps we remember each agent tab
// by URL and hand it back to that agent when the restored tab reappears.
const fs = require('fs');

class Owners {
  constructor(file) {
    this.file = file;
    this.map = {};
    this.urls = {};    // id -> last known URL of agent tabs, so a crash can't orphan them
    this.restore = []; // [{ url, owner }] waiting for their restored tab
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d.owners) { this.map = d.owners; this.urls = d.urls || {}; this.restore = d.restore || []; } else this.map = d;
    } catch {}
  }
  noteUrl(id, url) {
    if (this.map[id] && url && this.urls[id] !== url) { this.urls[id] = url; this.save(); }
  }
  // Chrome is about to start: ids from its last run are meaningless now, so
  // turn any agent tabs it had (clean sleep or crash) into URL claims
  prepareRestore() {
    for (const [id, owner] of Object.entries(this.map)) if (this.urls[id]) this.restore.push({ url: this.urls[id], owner });
    this.map = {}; this.urls = {};
    this.flush();
  }
  get(id) { return this.map[id]; }
  set(id, bot) { this.map[id] = bot; this.save(); }
  del(id) { delete this.map[id]; delete this.urls[id]; this.save(); }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this.timer);
    try { fs.writeFileSync(this.file, JSON.stringify({ owners: this.map, urls: this.urls, restore: this.restore })); } catch {}
  }
  // pages: [{ id, url }] currently open
  snapshot(pages) {
    for (const p of pages) this.noteUrl(p.id, p.url);
    this.prepareRestore();
  }
  // a restored page appeared: claim it if an agent had a tab at this URL
  claim(id, url) {
    if (this.map[id] || !url) return;
    const i = this.restore.findIndex(r => r.url === url);
    if (i < 0) return;
    this.map[id] = this.restore[i].owner;
    this.urls[id] = url;
    this.restore.splice(i, 1);
    this.save();
  }
  dropRestore() { if (this.restore.length) { this.restore = []; this.save(); } }
}

module.exports = Owners;
