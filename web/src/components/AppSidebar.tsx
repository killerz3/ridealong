import { useMemo } from 'react';
import {
  Activity as ActivityIcon, AppWindow, Ban, Check, ChevronRight, ChevronsUpDown, Keyboard, LayoutGrid, LogOut, Monitor, Moon,
  MoreHorizontal, Plug, Plus, Search, Settings2, Sun, Unplug, X, XCircle,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupAction, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton,
  SidebarMenuSubItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { AgentAvatar, Favicon, Logo, Shortcut, StateDot } from '@/components/bits';
import { currentWorkspace, openModal, useStore } from '@/lib/store';
import { MOBILE, send, setView, switchWorkspace, toggleActivity, viewTab } from '@/lib/conn';
import { ago, duration, modKey, tabTitle } from '@/lib/format';
import { useTheme, type Theme } from '@/lib/theme';
import type { TabInfo, WorkspaceInfo } from '@shared/protocol';

export function workspaceStatus(w: WorkspaceInfo) {
  if (w.error && w.state === 'asleep') return 'Could not start';
  if (w.state === 'waking') return 'Starting…';
  if (w.state === 'sleeping') return 'Going to sleep…';
  if (w.state === 'asleep') return 'Asleep · 0 MB';
  const bits = [w.memoryMB ? `${w.memoryMB} MB` : 'Awake'];
  if (w.agents.length) bits.push(`${w.agents.length} agent${w.agents.length > 1 ? 's' : ''}`);
  else if (w.sleepsIn != null && w.sleepsIn < 600) bits.push(`sleeps in ${duration(w.sleepsIn)}`);
  return bits.join(' · ');
}

function WorkspaceSwitcher() {
  const workspaces = useStore(s => s.workspaces);
  const current = useStore(currentWorkspace);
  const ws = useStore(s => s.ws);
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" aria-label="Switch workspace">
              <Logo state={current?.state} />
              <div className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-[13px] font-semibold text-sidebar-accent-foreground">{ws || 'tabkennel'}</span>
                <span className="truncate text-xs text-muted-foreground">{current ? workspaceStatus(current) : 'Connecting…'}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-(--radix-dropdown-menu-trigger-width) min-w-64" align="start" side={isMobile ? 'bottom' : 'bottom'} sideOffset={6}>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Workspaces · each has its own logins</DropdownMenuLabel>
            {workspaces.map(w => (
              <DropdownMenuItem key={w.name} onSelect={() => { switchWorkspace(w.name); setOpenMobile(false); }} className="gap-2.5 py-2">
                <StateDot w={w} />
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate font-medium">{w.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{workspaceStatus(w)}</span>
                </div>
                {w.name === ws && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openModal('newWorkspace')}>
              <Plus /> New workspace…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openModal('settings')}>
              <Settings2 /> Workspace settings…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function TabItem({ t, sub }: { t: TabInfo; sub?: boolean }) {
  const active = useStore(s => s.tab === t.id && s.view === 'browser');
  const { setOpenMobile } = useSidebar();
  const open = () => { viewTab(t.id); setOpenMobile(false); };
  const close = (e: React.MouseEvent) => { e.stopPropagation(); send({ t: 'close', id: t.id }); };
  if (sub) {
    return (
      <SidebarMenuSubItem className="group/tab relative">
        <SidebarMenuSubButton isActive={active} onClick={open} title={t.url} className="cursor-default pr-7">
          <Favicon url={t.url} className="size-3.5" />
          <span className="truncate">{tabTitle(t)}</span>
        </SidebarMenuSubButton>
        <button onClick={close} aria-label="Close tab"
          className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-border hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100">
          <X className="size-3" />
        </button>
      </SidebarMenuSubItem>
    );
  }
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={open} title={t.url} className="cursor-default">
        <Favicon url={t.url} />
        <span className="truncate">{tabTitle(t)}</span>
      </SidebarMenuButton>
      <SidebarMenuAction showOnHover onClick={close} aria-label="Close tab">
        <X />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

function AgentGroup({ name, tabs, live, lastActive }: { name: string; tabs: TabInfo[]; live: boolean; lastActive?: number }) {
  const viewing = useStore(s => tabs.some(t => t.id === s.tab));
  return (
    <Collapsible asChild defaultOpen className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className="cursor-default" tooltip={name}>
            <AgentAvatar name={name} live={live} />
            <span className="truncate font-medium">{name}</span>
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <SidebarMenuBadge className="right-8 text-muted-foreground">{tabs.length || ''}</SidebarMenuBadge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover={!viewing} aria-label={`${name} options`}>
              <MoreHorizontal />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-56">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {live ? `Connected${lastActive ? ` · active ${ago(lastActive)}` : ''}` : 'Not connected'}
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => toggleActivity(true)}><ActivityIcon /> Show activity</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openModal('connect', { connectAgent: name })}><Plug /> Connection details</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!tabs.length} onSelect={() => send({ t: 'agent', name, action: 'closeTabs' })}><XCircle /> Close its tabs</DropdownMenuItem>
            <DropdownMenuItem disabled={!live} onSelect={() => send({ t: 'agent', name, action: 'disconnect' })}><Unplug /> Disconnect</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => send({ t: 'agent', name, action: 'block' })}><Ban /> Block this agent</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <CollapsibleContent>
          <SidebarMenuSub>
            {tabs.map(t => <TabItem key={t.id} t={t} sub />)}
            {!tabs.length && <li className="px-2 py-1 text-xs text-muted-foreground">{live ? 'Connected, no tabs yet' : 'No open tabs'}</li>}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function ThemeItems() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={v => setTheme(v as Theme)}>
      <DropdownMenuRadioItem value="light"><Sun /> Light</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark"><Moon /> Dark</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system"><Monitor /> System</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

export function AppSidebar() {
  const tabs = useStore(s => s.tabs);
  const view = useStore(s => s.view);
  const wsState = useStore(s => s.wsState);
  const unseen = useStore(s => s.unseenActivity);
  const activityOpen = useStore(s => s.activityOpen);
  const info = useStore(currentWorkspace);
  const version = useStore(s => s.boot?.version);
  const { setOpenMobile } = useSidebar();

  const { mine, agents } = useMemo(() => {
    const mine = tabs.filter(t => !t.owner);
    const byAgent = new Map<string, TabInfo[]>();
    for (const a of info?.agents || []) byAgent.set(a.name, []);
    for (const t of tabs) if (t.owner) byAgent.set(t.owner, [...(byAgent.get(t.owner) || []), t]);
    const agents = [...byAgent].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => {
      const a = info?.agents.find(x => x.name === name);
      return { name, tabs: list, live: !!a, lastActive: a?.lastActive };
    });
    return { mine, agents };
  }, [tabs, info]);

  const awake = wsState === 'awake';

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="gap-2.5 pb-0">
        <WorkspaceSwitcher />
        <button
          onClick={() => openModal('palette')}
          className="flex h-8 w-full items-center gap-2 whitespace-nowrap rounded-md border bg-background/70 px-2.5 text-[13px] text-muted-foreground shadow-xs transition-colors hover:bg-background hover:text-foreground dark:bg-sidebar-accent/40"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="truncate">Search or jump to…</span>
          {!MOBILE && <Shortcut keys={[modKey, 'K']} />}
        </button>
      </SidebarHeader>

      <SidebarContent className="scrollbar-thin">
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={view === 'browser'} onClick={() => { setView('browser'); setOpenMobile(false); }}>
                <AppWindow /> Browser
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={view === 'overview'} onClick={() => { setView('overview'); setOpenMobile(false); }}>
                <LayoutGrid /> Overview
              </SidebarMenuButton>
              {awake && <SidebarMenuBadge className="text-muted-foreground">{tabs.length}</SidebarMenuBadge>}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={activityOpen} onClick={() => { toggleActivity(); setOpenMobile(false); }}>
                <ActivityIcon /> Activity
              </SidebarMenuButton>
              {unseen > 0 && (
                <SidebarMenuBadge className="rounded-full bg-signal px-1.5 text-[10.5px] font-semibold text-black">{unseen > 99 ? '99+' : unseen}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Your tabs</SidebarGroupLabel>
          <SidebarGroupAction title="New tab" disabled={!awake} onClick={() => { send({ t: 'new' }); setView('browser'); setOpenMobile(false); }}>
            <Plus /> <span className="sr-only">New tab</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {mine.map(t => <TabItem key={t.id} t={t} />)}
              {awake && !mine.length && <li className="px-2 py-1 text-xs text-muted-foreground">No tabs of your own</li>}
              {!awake && <li className="px-2 py-1 text-xs text-muted-foreground">{wsState === 'asleep' ? 'Tabs are saved while asleep' : 'Loading…'}</li>}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <SidebarGroupAction title="Connect an agent" onClick={() => openModal('connect', { connectAgent: null })}>
            <Plus /> <span className="sr-only">Connect an agent</span>
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {agents.map(a => <AgentGroup key={a.name} {...a} />)}
            </SidebarMenu>
            {!agents.length && (
              <div className="mx-2 mt-1 rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
                <p>Agents share this workspace’s logins, each in its own tabs.</p>
                <Button variant="outline" size="xs" className="mt-2.5 bg-background/60" onClick={() => openModal('connect', { connectAgent: null })}>
                  <Plug /> Connect an agent
                </Button>
              </div>
            )}
            {!!info?.blocked.length && (
              <div className="mx-2 mt-2 space-y-1">
                {info.blocked.map(b => (
                  <div key={b} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-xs text-muted-foreground">
                    <Ban className="size-3.5" />
                    <span className="truncate line-through">{b}</span>
                    <button className="ml-auto rounded px-1.5 py-0.5 hover:bg-sidebar-accent hover:text-foreground" onClick={() => send({ t: 'agent', name: b, action: 'unblock' })}>Unblock</button>
                  </div>
                ))}
              </div>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <Button variant="outline" className="w-full justify-start gap-2 bg-background/70 dark:bg-sidebar-accent/40" onClick={() => openModal('connect', { connectAgent: null })}>
          <Plug /> Connect an agent
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="text-muted-foreground">
              <Settings2 /> Preferences
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/70">v{version}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Theme</DropdownMenuLabel>
            <ThemeItems />
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openModal('settings')}><Settings2 /> Workspace settings</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openModal('shortcuts')}><Keyboard /> Keyboard shortcuts <DropdownMenuShortcut>?</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => { location.href = '/logout'; }}><LogOut /> Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
