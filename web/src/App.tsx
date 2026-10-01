import { useCallback, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/AppSidebar';
import { Toolbar, type OmniboxHandle } from '@/components/Toolbar';
import { Stage } from '@/components/Stage';
import { Overview } from '@/components/Overview';
import { ActivityPanel } from '@/components/ActivityPanel';
import { CommandPalette } from '@/components/CommandPalette';
import { ConnectDialog, FileChooserDialog, NewWorkspaceDialog, PageDialog, SettingsDialog, ShortcutsDialog, useGlobalKeys } from '@/components/Dialogs';
import { Login } from '@/components/Login';
import { set, useStore } from '@/lib/store';
import { startConnection } from '@/lib/conn';
import type { Boot } from '@shared/protocol';

function Shell() {
  const omnibox = useRef<OmniboxHandle>(null);
  const view = useStore(s => s.view);
  const focusAddress = useCallback(() => omnibox.current?.focus(), []);
  useGlobalKeys();
  useEffect(() => { startConnection(); }, []);
  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden md:peer-data-[variant=inset]:shadow-none md:peer-data-[variant=inset]:border">
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Toolbar ref={omnibox} />
            {/* the stage stays mounted so the stream keeps its canvas */}
            <div className={view === 'browser' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><Stage focusAddress={focusAddress} /></div>
            {view === 'overview' && <Overview />}
          </div>
          <ActivityPanel />
        </div>
      </SidebarInset>
      <CommandPalette />
      <ConnectDialog />
      <NewWorkspaceDialog />
      <SettingsDialog />
      <ShortcutsDialog />
      <PageDialog />
      <FileChooserDialog />
    </SidebarProvider>
  );
}

export function App() {
  const boot = useStore(s => s.boot);
  const load = useCallback(() => {
    fetch('/api/boot').then(r => r.json()).then((b: Boot) => set({ boot: b }), () => setTimeout(load, 2000));
  }, []);
  useEffect(load, [load]);
  return (
    <TooltipProvider delayDuration={300}>
      {!boot ? (
        <div className="grid h-svh place-items-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : boot.authed ? <Shell /> : <Login onDone={load} />}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
