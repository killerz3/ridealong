// Memory used by a workspace: Chrome's whole process tree plus its display.
// PSS splits shared pages between processes, so the sum is honest (RSS would
// count Chrome's shared libraries once per renderer).
import fs from 'node:fs';
import { readText } from './chrome.js';

function children(): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  let procs: string[] = [];
  try { procs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch {}
  for (const pid of procs) {
    const stat = readText(`/proc/${pid}/stat`);
    const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
    if (!ppid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid)!.push(+pid);
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
  const kids = children();
  return roots.map(pids => {
    let kb = 0;
    const queue = pids.filter((p): p is number => !!p);
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      kb += pssKB(pid);
      queue.push(...(kids.get(pid) || []));
    }
    return Math.round(kb / 1024);
  });
}
