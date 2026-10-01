import { useEffect, useMemo, useState } from 'react';
import { Activity as ActivityIcon, ArrowUpRight, Ban, Download, Moon, Plug, Power, Sunrise, Unplug, X, XCircle } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { AgentAvatar } from '@/components/bits';
import { useStore } from '@/lib/store';
import { toggleActivity } from '@/lib/conn';
import { ago, host } from '@/lib/format';
import type { Activity } from '@shared/protocol';

const VERB: Record<Activity['kind'], string> = {
  connect: 'connected', disconnect: 'disconnected', open: 'opened a tab', navigate: 'went to', close: 'closed a tab',
  wake: 'Workspace woke up', sleep: 'Workspace went to sleep', download: 'downloaded', blocked: 'was blocked',
};
const ICON: Record<Activity['kind'], React.ElementType> = {
  connect: Plug, disconnect: Unplug, open: ArrowUpRight, navigate: ArrowUpRight, close: XCircle,
  wake: Sunrise, sleep: Moon, download: Download, blocked: Ban,
};

function Row({ a, now }: { a: Activity; now: number }) {
  const Icon = ICON[a.kind] || Power;
  const system = a.kind === 'wake' || a.kind === 'sleep';
  let path = '';
  if (a.url) { try { const u = new URL(a.url); path = u.pathname === '/' ? '' : u.pathname + u.search; } catch {} }
  return (
    <li className="relative flex gap-3 py-2.5 pl-1 pr-2">
      {system || !a.agent
        ? <span className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Icon className="size-3" /></span>
        : <AgentAvatar name={a.agent} />}
      <div className="min-w-0 flex-1 text-[13px] leading-snug">
        <div>
          {!system && <span className="font-medium">{a.agent || 'You'} </span>}
          <span className={system ? 'text-muted-foreground' : 'text-muted-foreground'}>{VERB[a.kind]}{a.detail === 'crashed' ? ' (browser crashed)' : ''}</span>
          {a.kind === 'download' && a.detail && <span className="font-medium"> {a.detail}</span>}
        </div>
        {a.url && a.kind !== 'download' && (
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-muted-foreground" title={a.url}>
            <span className="text-foreground/80">{host(a.url)}</span>{path}
          </div>
        )}
      </div>
      <time className="shrink-0 pt-px text-[11px] tabular-nums text-muted-foreground" dateTime={new Date(a.at).toISOString()} title={new Date(a.at).toLocaleString()}>{ago(a.at, now)}</time>
    </li>
  );
}

function Feed() {
  const items = useStore(s => s.activity);
  const [agent, setAgent] = useState('all');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(t); }, []);
  useEffect(() => setNow(Date.now()), [items]);
  const agents = useMemo(() => [...new Set(items.map(i => i.agent).filter(Boolean) as string[])].sort(), [items]);
  const shown = items.filter(i => agent === 'all' || i.agent === agent).slice().reverse();
  return (
    <>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger size="sm" className="h-7 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            {agents.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 scrollbar-thin">
        {shown.length ? (
          <ol className="divide-y divide-border/60">{shown.map(a => <Row key={a.id} a={a} now={now} />)}</ol>
        ) : (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            <ActivityIcon className="mx-auto mb-3 size-5" />
            Nothing yet. When agents connect, open tabs and browse, it shows up here as it happens.
          </div>
        )}
      </div>
    </>
  );
}

export function ActivityPanel() {
  const open = useStore(s => s.activityOpen);
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={toggleActivity}>
        <SheetContent side="right" className="flex w-[88vw] flex-col gap-0 p-0">
          <SheetHeader className="border-b">
            <SheetTitle>Activity</SheetTitle>
            <SheetDescription>What agents are doing in this workspace</SheetDescription>
          </SheetHeader>
          <Feed />
        </SheetContent>
      </Sheet>
    );
  }
  if (!open) return null;
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-background" aria-label="Activity">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <ActivityIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Activity</h2>
        <Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label="Close activity" onClick={() => toggleActivity(false)}><X /></Button>
      </div>
      <Feed />
    </aside>
  );
}
