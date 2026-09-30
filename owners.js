// targetId -> bot name, persisted so the viewer can label tabs across restarts
const fs = require('fs');
const path = require('path');
const FILE = path.join(process.env.AB_HOME || path.join(require('os').homedir(), '.agent-browser'), 'owners.json');
let map = {};
try { map = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFileSync(FILE, JSON.stringify(map)), 200); };
module.exports = {
  get: id => map[id],
  set: (id, bot) => { map[id] = bot; save(); },
  del: id => { delete map[id]; save(); },
  all: () => map,
};
