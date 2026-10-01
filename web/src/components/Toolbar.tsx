import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Camera, Download, FileDown, Keyboard, Lock, Maximize2, Minimize2, Moon, MoreHorizontal, PanelRight,
  RotateCw, Search, Settings2, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Progress } from '@/components/ui/progress';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { AgentAvatar } from '@/components/bits';
import { currentTab, currentWorkspace, get, openModal, set, useStore } from '@/lib/store';
import { MOBILE, VIDEO_OK, navigate, saveDownload, send, setMode, toggleActivity } from '@/lib/conn';
import { agentColor, ago, bytes, isBlank, modKey, splitUrl } from '@/lib/format';
import { cn } from '@/lib/utils';

function IconButton({ label, shortcut, className, ...props }: React.ComponentProps<typeof Button> & { label: string; shortcut?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} className={cn('text-muted-foreground hover:text-foreground', className)} {...props} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}{shortcut && <span className="ml-2 opacity-60">{shortcut}</span>}</TooltipContent>
    </Tooltip>
  );
}

export interface OmniboxHandle { focus(): void }

const Omnibox = forwardRef<OmniboxHandle>(function Omnibox(_, ref) {
  const url = useStore(s => s.page.url);
  const awake = useStore(s => s.wsState === 'awake');
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const justFocused = useRef(false);
  const [value, setValue] = useState('');
  useImperativeHandle(ref, () => ({ focus: () => { input.current?.focus(); input.current?.select(); } }));
  useEffect(() => { if (!focused) setValue(isBlank(url) ? '' : url); }, [url, focused]);
  const parts = splitUrl(url);
  const pretty = !focused && !isBlank(url) && /^https?:/.test(url);
  return (
    <div className={cn(
      'group relative flex h-8 min-w-0 flex-1 items-center rounded-lg border border-transparent bg-muted/70 transition-colors',
      'focus-within:border-ring/60 focus-within:bg-background focus-within:ring-[3px] focus-within:ring-ring/15 hover:bg-muted',
    )}>
      <span className="pointer-events-none grid w-8 shrink-0 place-items-center text-muted-foreground">
        {pretty && parts.secure ? <Lock className="size-3.5" /> : <Search className="size-3.5" />}
      </span>
      <input
        ref={input}
        value={value}
        disabled={!awake}
        onChange={e => setValue(e.target.value)}
        // select right away: deferring it would swallow the first key typed
        onFocus={e => { setFocused(true); e.target.select(); }}
        onMouseUp={e => { if (justFocused.current) { e.preventDefault(); justFocused.current = false; } }}
        onMouseDown={() => { justFocused.current = document.activeElement !== input.current; }}
        onBlur={() => setFocused(false)}
        onKeyDown={e => {
          if (e.key === 'Enter' && value.trim()) { navigate(value); (document.querySelector('[data-stage]') as HTMLElement | null)?.focus(); }
          if (e.key === 'Escape') { setValue(isBlank(url) ? '' : url); (document.querySelector('[data-stage]') as HTMLElement | null)?.focus(); }
        }}
        placeholder="Search or enter address"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-label="Address"
        className={cn('h-full min-w-0 flex-1 bg-transparent pr-3 text-[13px] outline-none placeholder:text-muted-foreground', pretty && 'text-transparent caret-foreground selection:text-foreground')}
      />
      {pretty && (
        <span className="pointer-events-none absolute inset-y-0 left-8 right-3 flex items-center overflow-hidden whitespace-nowrap text-[13px]">
          <span className="text-foreground">{parts.host}</span>
          <span className="truncate text-muted-foreground">{parts.rest}</span>
        </span>
      )}
    </div>
  );
});

function StatusPill() {
  const stats = useStore(s => s.stats);
  const ping = useStore(s => s.pingRtt);
  const mode = useStore(s => s.mode);
  const link = useStore(s => s.link);
  const videoServer = useStore(s => s.boot?.video ?? false);
  const rtt = Math.max(stats?.rtt || 0, ping || 0);
  const tone = link !== 'open' ? 'bg-destructive' : rtt > 250 ? 'bg-destructive' : rtt > 120 ? 'bg-warn' : 'bg-signal';
  const kb = (n: number) => n > 999 ? `${(n / 1000).toFixed(1)} Mb/s` : `${n} kb/s`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 font-mono text-xs tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Connection and streaming">
          <span className={cn('size-1.5 rounded-full', tone)} />
          <span className="hidden sm:inline">{link === 'open' ? `${rtt} ms` : 'offline'}</span>
          <span className="hidden text-muted-foreground/60 lg:inline">{mode === 'video' ? 'video' : 'images'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="grid grid-cols-3 divide-x border-b">
          {[['Latency', link === 'open' ? `${rtt} ms` : '—'], ['Frames', stats ? `${stats.fps}/s` : '—'], ['Bandwidth', stats ? kb(stats.kbps) : '—']].map(([k, v]) => (
            <div key={k} className="px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">{k}</div>
              <div className="font-mono text-sm tabular-nums">{v}</div>
            </div>
          ))}
        </div>
        <div className="space-y-2.5 p-3">
          <div className="text-xs font-medium">Streaming</div>
          <ToggleGroup type="single" variant="outline" size="sm" className="w-full" value={mode} onValueChange={v => v && setMode(v as 'jpeg' | 'video')}>
            <ToggleGroupItem value="jpeg" className="flex-1">Images</ToggleGroupItem>
            <ToggleGroupItem value="video" className="flex-1" disabled={!VIDEO_OK || !videoServer}>Video</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {mode === 'jpeg'
              ? `Sharp frames, sent only when the page changes. Adapts to slow links${stats?.quality ? ` (quality ${stats.quality})` : ''}.`
              : 'Smooth H.264 video for scrolling and animation. Uses more server CPU while you watch.'}
            {!videoServer ? ' Video needs ffmpeg on the server.' : !VIDEO_OK ? ' Video needs https (or localhost) and a browser with WebCodecs.' : ''}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Downloads() {
  const items = useStore(s => s.downloads);
  const unseen = useStore(s => s.unseenDownloads);
  const ws = useStore(s => s.ws);
  if (!items.length) return null;
  const busy = items.some(d => d.state === 'inProgress');
  return (
    <Popover onOpenChange={o => o && set({ unseenDownloads: 0 })}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative text-muted-foreground hover:text-foreground" aria-label="Downloads">
              <Download className={cn(busy && 'animate-pulse')} />
              {unseen > 0 && <span className="absolute right-1 top-1 size-2 rounded-full bg-signal" />}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Downloads</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-88 p-0">
        <div className="border-b px-3 py-2.5">
          <div className="text-sm font-medium">Downloads</div>
          <div className="text-xs text-muted-foreground">Files saved by the browser in “{ws}”. Save them to this device.</div>
        </div>
        <div className="max-h-80 overflow-y-auto p-1 scrollbar-thin">
          {items.map(d => (
            <div key={d.id} className="group flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/60">
              <FileDown className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">{d.name}</div>
                {d.state === 'inProgress'
                  ? <Progress value={d.total ? (d.received / d.total) * 100 : 30} className="mt-1.5 h-1" />
                  : <div className="text-xs text-muted-foreground">{d.state === 'completed' ? `${bytes(d.received)} · ${ago(d.at)}` : 'Canceled'}</div>}
              </div>
              {d.state === 'completed' && <Button size="xs" variant="outline" onClick={() => saveDownload(d.id)}>Save</Button>}
              <button aria-label="Remove" className="text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                onClick={() => fetch(`/api/downloads/${encodeURIComponent(ws || '')}/${d.id}`, { method: 'DELETE' })}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function useFullscreen() {
  const [on, setOn] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const f = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  const toggle = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {});
  return [on, toggle] as const;
}

export const Toolbar = forwardRef<OmniboxHandle>(function Toolbar(_, ref) {
  const page = useStore(s => s.page);
  const loading = useStore(s => s.loading);
  const awake = useStore(s => s.wsState === 'awake');
  const tab = useStore(currentTab);
  const info = useStore(currentWorkspace);
  const view = useStore(s => s.view);
  const activityOpen = useStore(s => s.activityOpen);
  const [fullscreen, toggleFullscreen] = useFullscreen();
  const owner = tab?.owner;
  const live = !!owner && !!info?.agents.some(a => a.name === owner);

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <SidebarTrigger className="text-muted-foreground" />
      {view === 'browser' ? (
        <>
          <div className="flex items-center">
            <IconButton label="Back" disabled={!page.canBack} onClick={() => send({ t: 'back' })}><ArrowLeft /></IconButton>
            <IconButton label="Forward" disabled={!page.canFwd} onClick={() => send({ t: 'fwd' })} className="hidden sm:inline-flex"><ArrowRight /></IconButton>
            {loading
              ? <IconButton label="Stop" onClick={() => send({ t: 'stop' })}><X /></IconButton>
              : <IconButton label="Reload" disabled={!awake} onClick={() => send({ t: 'reload' })}><RotateCw /></IconButton>}
          </div>
          {owner && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs md:flex" style={{ borderColor: agentColor(owner) }}>
                  <AgentAvatar name={owner} className="size-4 text-[8px]" />
                  <span className="max-w-32 truncate">{owner}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                This tab belongs to {owner}{live ? ', which is connected right now' : ''}. You can still click and type in it.
              </TooltipContent>
            </Tooltip>
          )}
          <Omnibox ref={ref} />
          {MOBILE && <IconButton label="Keyboard" onClick={() => { const k = document.querySelector<HTMLTextAreaElement>('#kbd'); if (k) { k.value = ' '; k.focus(); } }}><Keyboard /></IconButton>}
        </>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <h1 className="text-sm font-medium">Overview</h1>
          <span className="truncate text-xs text-muted-foreground">Every tab in “{info?.name}”, live</span>
        </div>
      )}
      <div className="ml-1 flex items-center gap-0.5">
        <StatusPill />
        <Downloads />
        <IconButton label={activityOpen ? 'Hide activity' : 'Show activity'} onClick={() => toggleActivity()} className={cn('hidden md:inline-flex', activityOpen && 'bg-accent text-foreground')}>
          <PanelRight />
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label="More">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem disabled={!tab} onSelect={() => send({ t: 'screenshot' })}><Camera /> Save a screenshot</DropdownMenuItem>
            <DropdownMenuItem onSelect={toggleFullscreen}>{fullscreen ? <Minimize2 /> : <Maximize2 />} {fullscreen ? 'Exit full screen' : 'Full screen'}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openModal('palette')}><Search /> Search tabs and actions <DropdownMenuShortcut>{modKey}K</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openModal('settings')}><Settings2 /> Workspace settings</DropdownMenuItem>
            <DropdownMenuItem disabled={!awake} onSelect={() => { const n = get().ws; if (n) send({ t: 'sleep', name: n }); }}><Moon /> Put “{info?.name}” to sleep</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {loading && view === 'browser' && (
        <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden">
          <div className="h-full w-full origin-left animate-indeterminate bg-signal" />
        </div>
      )}
    </header>
  );
});
