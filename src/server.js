const { Manager } = require('./workspaces');
const viewer = require('./viewer');
const agentproxy = require('./agentproxy');

async function serve(cfg) {
  if (!cfg.password) throw new Error('no password set: run `tabkennel setup` or set TABKENNEL_PASSWORD');
  const manager = new Manager(cfg);
  const listen = async (what, port, fn) => {
    try { return await fn(); } catch (e) {
      if (e.code === 'EADDRINUSE') throw new Error(`port ${port} (${what}) is already in use. Is tabkennel already running? Try \`tabkennel status\`.`);
      throw e;
    }
  };
  await listen('viewer', cfg.viewerPort, () => viewer.start({ cfg, manager }));
  await listen('agents', cfg.agentPort, () => agentproxy.start({ port: cfg.agentPort, bind: cfg.bind, manager }));

  const host = cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind;
  console.log(`tabkennel is running
  viewer  http://${host}:${cfg.viewerPort}
  agents  ws://${host}:${cfg.agentPort}/<workspace>/<agent>/devtools/browser
  data    ${cfg.home}
  workspaces sleep after ${cfg.idleMinutes ? cfg.idleMinutes + ' idle minutes' : 'never (idleMinutes = 0)'}`);

  manager.on('change', w => {
    if (!w || w.state === w.lastLogged) return;
    w.lastLogged = w.state;
    if (w.state === 'awake' || w.state === 'asleep') console.log(`workspace ${w.name}: ${w.state}${w.error ? ` (${w.error})` : ''}`);
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return process.exit(1);
    stopping = true;
    console.log('saving sessions and stopping browsers…');
    await manager.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return manager;
}

module.exports = { serve };
