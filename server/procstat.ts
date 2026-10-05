// Process table helpers. Linux reads /proc; macOS has no /proc, so it asks ps.
// Memory used by a workspace is Chrome's whole process tree plus its display.
// On Linux PSS splits shared pages between processes, so the sum is honest
// (RSS would count Chrome's shared libraries once per renderer). macOS only
// exposes RSS, so its figure runs high.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readText } from './chrome.js';

const procfs = process.platform === 'linux';

interface PsRow { pid: number; ppid: number; kb: number; cmd: string }
export function ps(): PsRow[] {
  const out = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
  const rows: PsRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: +m[1], ppid: +m[2], kb: +m[3], cmd: m[4] });
  }
  return rows;
}

const procPids = () => { try { return fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number); } catch { return []; } };

// pid -> command line (args joined by NULs on Linux, spaces from ps)
export function commandLines(): Map<number, string> {
  if (!procfs) return new Map(ps().map(r => [r.pid, r.cmd]));
  return new Map(procPids().map(pid => [pid, readText(`/proc/${pid}/cmdline`)]));
}

export function alive(pid: number): boolean {
  if (procfs) return fs.existsSync(`/proc/${pid}`) && !/\) Z /.test(readText(`/proc/${pid}/stat`));
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function children(): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  const add = (pid: number, ppid: number) => {
    if (!ppid) return;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid)!.push(pid);
  };
  for (const pid of procPids()) {
    const stat = readText(`/proc/${pid}/stat`);
    add(pid, +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  }
  return kids;
}

function pssKB(pid: number) {
  const m = readText(`/proc/${pid}/smaps_rollup`).match(/^Pss:\s+(\d+)/m);
  if (m) return +m[1];
  const r = readText(`/proc/${pid}/status`).match(/^VmRSS:\s+(\d+)/m);
  return r ? +r[1] : 0;
}

// roots: [[chromePid, xvfbPid], ...] -> MB per entry
export function treeMemoryMB(roots: (number | undefined)[][]): number[] {
  let kids: Map<number, number[]>, kbOf: (pid: number) => number;
  if (procfs) { kids = children(); kbOf = pssKB; } else {
    const rows = ps(), rss = new Map(rows.map(r => [r.pid, r.kb]));
    kids = new Map();
    for (const r of rows) { if (!kids.has(r.ppid)) kids.set(r.ppid, []); kids.get(r.ppid)!.push(r.pid); }
    kbOf = pid => rss.get(pid) || 0;
  }
  return roots.map(pids => {
    let kb = 0;
    const queue = pids.filter((p): p is number => !!p);
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      kb += kbOf(pid);
      queue.push(...(kids.get(pid) || []));
    }
    return Math.round(kb / 1024);
  });
}
