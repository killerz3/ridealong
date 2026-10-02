import { Manager } from './workspaces.js';
import * as viewer from './viewer.js';
import * as agentproxy from './agentproxy.js';
import type { Config } from './config.js';

export async function serve(cfg: Config) {
  if (!cfg.password) throw new Error('no password set: run `ridealong setup` or set RIDEALONG_PASSWORD');
  const manager = new Manager(cfg);
  await manager.ready;
  const listen = async <T>(what: string, port: number, fn: () => Promise<T>) => {
    try { return await fn(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${port} (${what}) is already in use. Is ridealong already running? Try \`ridealong status\`.`);
      throw e;
    }
  };
  await listen('viewer', cfg.viewerPort, () => viewer.start({ cfg, manager }));
  await listen('agents', cfg.agentPort, () => agentproxy.start({ port: cfg.agentPort, bind: cfg.bind, manager }));

  const host = cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind;
  console.log(`ridealong is running
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
