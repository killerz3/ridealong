import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentAvatar, Favicon } from '@/components/bits';
import { currentWorkspace, useStore } from '@/lib/store';
import { send, setView, viewTab } from '@/lib/conn';
import { agentColor, host, isBlank, tabTitle } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TabInfo } from '@shared/protocol';

function Card({ t, live }: { t: TabInfo; live: boolean }) {
  const thumb = useStore(s => s.thumbs[t.id]);
  const current = useStore(s => s.tab === t.id);
  return (
    <div className="group relative">
      <button
        onClick={() => viewTab(t.id)}
        className={cn(
          'block w-full overflow-hidden rounded-xl border bg-card text-left shadow-xs transition-[box-shadow,border-color] hover:shadow-md focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none',
          current && 'ring-2 ring-ring/60',
        )}
        style={t.owner ? { borderColor: agentColor(t.owner) } : undefined}
      >
        <div className="relative aspect-[16/10] overflow-hidden border-b bg-muted">
          {thumb
            ? <img src={thumb} alt="" className="size-full object-cover object-top" />
            : <div className="grid size-full place-items-center text-xs text-muted-foreground">{isBlank(t.url) ? 'New tab' : 'Capturing…'}</div>}
          {t.owner && (
            <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full border bg-background/90 py-0.5 pl-0.5 pr-2 text-[11px] font-medium shadow-xs backdrop-blur">
              <AgentAvatar name={t.owner} live={live} className="size-4 text-[8px]" />
              {t.owner}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Favicon url={t.url} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{tabTitle(t)}</div>
            <div className="truncate text-xs text-muted-foreground">{isBlank(t.url) ? 'about:blank' : host(t.url)}</div>
          </div>
        </div>
      </button>
      <button
        onClick={() => send({ t: 'close', id: t.id })}
        aria-label="Close tab"
        className="absolute right-2 top-2 grid size-6 place-items-center rounded-full border bg-background/90 text-muted-foreground opacity-0 shadow-xs backdrop-blur transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function Overview() {
  const tabs = useStore(s => s.tabs);
  const info = useStore(currentWorkspace);
  const awake = useStore(s => s.wsState === 'awake');
  const [filter, setFilter] = useState<string>('all');
  const owners = useMemo(() => [...new Set(tabs.map(t => t.owner).filter(Boolean) as string[])].sort(), [tabs]);
  const shown = tabs.filter(t => filter === 'all' || (filter === 'you' ? !t.owner : t.owner === filter));
  const chip = (key: string, label: React.ReactNode, count: number) => (
    <button key={key} onClick={() => setFilter(key)}
      className={cn('flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors',
        filter === key ? 'border-foreground/20 bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
      {label}<span className="tabular-nums opacity-60">{count}</span>
    </button>
  );

  if (!awake) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
        <div>
          “{info?.name}” is {info?.state === 'asleep' ? 'asleep' : 'starting'}.
          {info?.state === 'asleep' && <Button variant="link" onClick={() => send({ t: 'wake' })}>Wake it up</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {chip('all', 'All', tabs.length)}
          {chip('you', 'You', tabs.filter(t => !t.owner).length)}
          {owners.map(o => chip(o, <><span className="size-2 rounded-full" style={{ background: agentColor(o) }} />{o}</>, tabs.filter(t => t.owner === o).length))}
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => { send({ t: 'new' }); setView('browser'); }}><Plus /> New tab</Button>
        </div>
        {shown.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {shown.map(t => <Card key={t.id} t={t} live={!!t.owner && !!info?.agents.some(a => a.name === t.owner)} />)}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No tabs here.</div>
        )}
      </div>
    </div>
  );
}
