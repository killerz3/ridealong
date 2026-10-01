import { useState } from 'react';
import {
  Activity, AppWindow, Camera, Clapperboard, Globe, Image, Keyboard, LayoutGrid, LogOut, Monitor, Moon, Plug, Plus,
  Search, Settings2, Sun, SquarePlus,
} from 'lucide-react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { AgentAvatar, Favicon, StateDot } from '@/components/bits';
import { closeModal, openModal, useStore } from '@/lib/store';
import { VIDEO_OK, navigate, send, setMode, setView, switchWorkspace, toggleActivity, viewTab } from '@/lib/conn';
import { host, tabTitle } from '@/lib/format';
import { setTheme } from '@/lib/theme';
import { workspaceStatus } from '@/components/AppSidebar';

const looksLikeUrl = (q: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^[^\s]+\.[a-z]{2,}(\/\S*)?$/i.test(q) || /^localhost(:\d+)?/.test(q);

export function CommandPalette() {
  const open = useStore(s => s.modal === 'palette');
  const tabs = useStore(s => s.tabs);
  const workspaces = useStore(s => s.workspaces);
  const ws = useStore(s => s.ws);
  const mode = useStore(s => s.mode);
  const view = useStore(s => s.view);
  const awake = useStore(s => s.wsState === 'awake');
  const videoServer = useStore(s => s.boot?.video ?? false);
  const [q, setQ] = useState('');

  const run = (fn: () => void) => () => { closeModal(); setQ(''); fn(); };
  const query = q.trim();
  const url = looksLikeUrl(query);
  // an address goes first; plain words are a web search after any matching commands
  const go = query && awake && (
    <CommandGroup heading={url ? 'Go to' : 'Search the web'} forceMount>
      <CommandItem forceMount value={query} onSelect={run(() => { setView('browser'); navigate(query); })}>
        {url ? <Globe /> : <Search />}
        <span className="truncate">{url ? query : `Search for “${query}”`}</span>
        <span className="ml-auto text-xs text-muted-foreground">this tab</span>
      </CommandItem>
      <CommandItem forceMount value={`${query} (new tab)`} onSelect={run(() => { setView('browser'); send({ t: 'new', url: query }); })}>
        <SquarePlus />
        <span className="truncate">{url ? query : `Search for “${query}”`}</span>
        <span className="ml-auto text-xs text-muted-foreground">new tab</span>
      </CommandItem>
    </CommandGroup>
  );

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) { closeModal(); setQ(''); } }}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search tabs and actions</DialogTitle>
        <DialogDescription className="sr-only">Jump to a tab or workspace, open an address, or run an action.</DialogDescription>
        <Command loop className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-item]]:h-9 [&_[cmdk-item]]:gap-2.5 [&_[cmdk-item]]:rounded-md [&_[cmdk-item]]:px-2.5">
          <div className="[&_[data-slot=command-input-wrapper]]:h-12 [&_[data-slot=command-input-wrapper]]:px-4">
            <CommandInput value={q} onValueChange={setQ} placeholder="Jump to a tab, open an address, or run a command…" className="text-[15px]" />
          </div>
          <CommandList className="max-h-[min(420px,60vh)] p-1.5 scrollbar-thin">
            <CommandEmpty>Nothing matches “{query}”.</CommandEmpty>
            {url && go}
            {tabs.length > 0 && (
              <CommandGroup heading="Tabs">
                {tabs.map(t => (
                  <CommandItem key={t.id} value={`tab:${t.id}`} keywords={[tabTitle(t), t.url, t.owner || 'you']} onSelect={run(() => viewTab(t.id))}>
                    <Favicon url={t.url} />
                    <span className="truncate">{tabTitle(t)}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <span className="max-w-40 truncate">{host(t.url)}</span>
                      {t.owner && <AgentAvatar name={t.owner} className="size-4 text-[8px]" />}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Workspaces">
              {workspaces.map(w => (
                <CommandItem key={w.name} value={`ws:${w.name}`} keywords={[w.name, 'workspace', 'switch']} onSelect={run(() => switchWorkspace(w.name))}>
                  <StateDot w={w} className="mx-1" />
                  <span>{w.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{w.name === ws ? 'current · ' : ''}{workspaceStatus(w)}</span>
                </CommandItem>
              ))}
              <CommandItem value="new workspace" keywords={['create', 'profile']} onSelect={run(() => openModal('newWorkspace'))}><Plus /> New workspace…</CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Actions">
              <CommandItem value="new tab" disabled={!awake} onSelect={run(() => { setView('browser'); send({ t: 'new' }); })}><SquarePlus /> New tab</CommandItem>
              <CommandItem value="overview" keywords={['grid', 'all tabs', 'thumbnails']} onSelect={run(() => setView(view === 'overview' ? 'browser' : 'overview'))}>
                {view === 'overview' ? <AppWindow /> : <LayoutGrid />} {view === 'overview' ? 'Back to the browser' : 'Overview of all tabs'}
              </CommandItem>
              <CommandItem value="activity" keywords={['feed', 'log', 'agents']} onSelect={run(() => toggleActivity())}><Activity /> Show or hide activity</CommandItem>
              <CommandItem value="connect an agent" keywords={['mcp', 'claude', 'playwright', 'puppeteer']} onSelect={run(() => openModal('connect', { connectAgent: null }))}><Plug /> Connect an agent</CommandItem>
              <CommandItem value="screenshot" disabled={!awake} onSelect={run(() => send({ t: 'screenshot' }))}><Camera /> Save a screenshot</CommandItem>
              {mode === 'jpeg'
                ? <CommandItem value="video mode" disabled={!VIDEO_OK || !videoServer} keywords={['stream', 'smooth', 'h264']} onSelect={run(() => setMode('video'))}><Clapperboard /> Stream as video</CommandItem>
                : <CommandItem value="images mode" keywords={['stream', 'jpeg', 'sharp']} onSelect={run(() => setMode('jpeg'))}><Image /> Stream as images</CommandItem>}
              <CommandItem value="workspace settings" keywords={['sleep', 'idle', 'delete']} onSelect={run(() => openModal('settings'))}><Settings2 /> Workspace settings</CommandItem>
              <CommandItem value="sleep workspace" disabled={!awake} keywords={['stop', 'memory']} onSelect={run(() => ws && send({ t: 'sleep', name: ws }))}><Moon /> Put “{ws}” to sleep</CommandItem>
            </CommandGroup>
            <CommandGroup heading="Preferences">
              <CommandItem value="theme light" onSelect={run(() => setTheme('light'))}><Sun /> Light theme</CommandItem>
              <CommandItem value="theme dark" onSelect={run(() => setTheme('dark'))}><Moon /> Dark theme</CommandItem>
              <CommandItem value="theme system" onSelect={run(() => setTheme('system'))}><Monitor /> Match system theme</CommandItem>
              <CommandItem value="keyboard shortcuts" onSelect={run(() => openModal('shortcuts'))}><Keyboard /> Keyboard shortcuts</CommandItem>
              <CommandItem value="sign out" keywords={['logout']} onSelect={run(() => { location.href = '/logout'; })}><LogOut /> Sign out</CommandItem>
            </CommandGroup>
            {!url && go}
          </CommandList>
          <div className="flex items-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span><kbd className="font-mono">↑↓</kbd> move</span>
            <span><kbd className="font-mono">↵</kbd> open</span>
            <span><kbd className="font-mono">esc</kbd> close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
