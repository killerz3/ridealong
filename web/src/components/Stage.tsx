import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Moon, Plus, Search, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentAvatar, Favicon } from '@/components/bits';
import { currentTab, currentWorkspace, useStore } from '@/lib/store';
import { attachStage, navigate, recentUrls, send, stageSize } from '@/lib/conn';
import { bindInput } from '@/lib/input';
import { agentColor, host, isBlank, tabTitle } from '@/lib/format';
import { cn } from '@/lib/utils';

function Cover({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('absolute inset-0 z-10 grid place-items-center bg-stage p-6', className)}>
      <div className="flex max-w-sm flex-col items-center text-center">{children}</div>
    </div>
  );
}

function StartPage() {
  const [q, setQ] = useState('');
  const recent = recentUrls().slice(0, 8);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center gap-8 px-6 py-12">
        <form
          onSubmit={e => { e.preventDefault(); if (q.trim()) navigate(q); }}
          className="flex h-12 items-center gap-3 rounded-xl border bg-card px-4 shadow-sm focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15"
        >
          <Search className="size-4 text-muted-foreground" />
          <input ref={input} value={q} onChange={e => setQ(e.target.value)} placeholder="Search the web or type an address"
            className="h-full flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground" spellCheck={false} autoCapitalize="off" />
        </form>
        {recent.length > 0 && (
          <div>
            <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Recently visited</div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {recent.map(r => (
                <button key={r.url} onClick={() => navigate(r.url)}
                  className="flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent">
                  <Favicon url={r.url} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">{r.title || host(r.url)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{host(r.url)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Stage({ focusAddress }: { focusAddress: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const kbd = useRef<HTMLTextAreaElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const link = useStore(s => s.link);
  const wsState = useStore(s => s.wsState);
  const wsError = useStore(s => s.wsError);
  const ws = useStore(s => s.ws);
  const tabId = useStore(s => s.tab);
  const tab = useStore(currentTab);
  const tabsCount = useStore(s => s.tabs.length);
  const hasFrame = useStore(s => s.hasFrame);
  const frame = useStore(s => s.frame);
  const url = useStore(s => s.page.url);
  const loading = useStore(s => s.loading);
  const info = useStore(currentWorkspace);

  useLayoutEffect(() => {
    attachStage(stage.current, canvas.current);
    const off = bindInput(stage.current!, canvas.current!, kbd.current!, focusAddress);
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      const r = stage.current!.getBoundingClientRect();
      setBox({ w: r.width, h: r.height });
      clearTimeout(t);
      t = setTimeout(() => send({ t: 'size', ...stageSize() }), 200);
    });
    ro.observe(stage.current!);
    return () => { off(); ro.disconnect(); attachStage(null, null); };
  }, [focusAddress]);

  // fit the page into the stage, never upscaling an agent's larger window
  const scale = frame && box.w ? Math.min(box.w / frame.w, box.h / frame.h, 1) : 1;
  const cssW = frame ? Math.floor(frame.w * scale) : 0, cssH = frame ? Math.floor(frame.h * scale) : 0;
  const owner = tab?.owner;
  const live = !!owner && !!info?.agents.some(a => a.name === owner);
  const fills = !!frame && cssW >= box.w - 1 && cssH >= box.h - 1;

  let cover: React.ReactNode = null;
  if (link !== 'open') {
    cover = <Cover><WifiOff className="mb-4 size-6 text-muted-foreground" /><h2 className="text-base font-medium">Reconnecting…</h2><p className="mt-1.5 text-sm text-muted-foreground">Lost the connection to ridealong. Trying again.</p></Cover>;
  } else if (wsState === 'connecting' || wsState === 'waking') {
    cover = (
      <Cover>
        <Loader2 className="mb-4 size-6 animate-spin text-muted-foreground" />
        <h2 className="text-base font-medium">{wsState === 'waking' ? `Waking “${ws}”` : 'Connecting…'}</h2>
        {wsState === 'waking' && <p className="mt-1.5 text-sm text-muted-foreground">Starting its browser and restoring your tabs. This takes a couple of seconds.</p>}
      </Cover>
    );
  } else if (wsState === 'asleep') {
    cover = (
      <Cover>
        <div className="mb-5 grid size-12 place-items-center rounded-2xl border bg-card shadow-sm"><Moon className="size-5" /></div>
        <h2 className="text-lg font-semibold tracking-tight">“{ws}” is asleep</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {wsError ? wsError + '. ' : ''}Its browser is stopped, so it uses no memory. Your logins and tabs are saved and come back when it wakes.
        </p>
        <Button className="mt-5" onClick={() => send({ t: 'wake' })}>Wake it up</Button>
      </Cover>
    );
  } else if (wsState === 'error') {
    cover = (
      <Cover>
        <div className="mb-5 grid size-12 place-items-center rounded-2xl border border-destructive/30 bg-destructive/10 text-destructive"><AlertTriangle className="size-5" /></div>
        <h2 className="text-lg font-semibold tracking-tight">“{ws}” couldn’t start</h2>
        <pre className="mt-3 max-h-40 w-full max-w-md overflow-auto whitespace-pre-wrap rounded-lg border bg-card p-3 text-left font-mono text-xs text-muted-foreground">{wsError || 'Unknown error'}</pre>
        <p className="mt-3 text-xs text-muted-foreground">Run <code className="font-mono">ridealong doctor</code> on the server to check what’s missing.</p>
        <Button className="mt-4" onClick={() => send({ t: 'wake' })}>Try again</Button>
      </Cover>
    );
  } else if (!tabId) {
    cover = (
      <Cover>
        <h2 className="text-base font-medium">{tabsCount ? 'Pick a tab' : 'No open tabs'}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">Open a tab to start browsing in “{ws}”.</p>
        <Button className="mt-4" onClick={() => send({ t: 'new' })}><Plus /> New tab</Button>
      </Cover>
    );
  } else if (!hasFrame) {
    cover = <Cover className="bg-stage/60"><Loader2 className="size-5 animate-spin text-muted-foreground" /></Cover>;
  }

  const startPage = !cover && !owner && isBlank(url) && !loading;

  return (
    <div
      ref={stage}
      data-stage
      tabIndex={0}
      aria-label={tab ? `Remote page: ${tabTitle(tab)}` : 'Remote browser'}
      className="relative min-h-0 flex-1 overflow-hidden bg-stage outline-none"
    >
      <div className="absolute inset-0 grid place-items-center">
        <canvas
          ref={canvas}
          style={{ width: cssW || undefined, height: cssH || undefined, ...(owner && { outline: `2px solid ${agentColor(owner)}`, outlineOffset: fills ? -2 : 0 }) }}
          className={cn('block touch-none bg-white', !fills && 'rounded-md shadow-lg', !hasFrame && 'invisible')}
        />
      </div>
      {owner && hasFrame && !cover && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-full border bg-background/85 py-1 pl-1 pr-3 text-xs shadow-sm backdrop-blur">
          <AgentAvatar name={owner} live={live} />
          <span><span className="font-medium">{owner}</span><span className="text-muted-foreground">{live ? ' is connected · you can take over' : '’s tab'}</span></span>
        </div>
      )}
      <textarea id="kbd" ref={kbd} className="pointer-events-none absolute -left-full size-px opacity-0" autoCapitalize="off" autoComplete="off" spellCheck={false} aria-hidden tabIndex={-1} />
      {startPage && <StartPage />}
      {cover}
    </div>
  );
}
