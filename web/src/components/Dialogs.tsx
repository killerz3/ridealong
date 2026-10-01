import { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, FileUp, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { AgentAvatar } from '@/components/bits';
import { closeModal, currentWorkspace, get, set, useStore } from '@/lib/store';
import { send, switchWorkspace, uploadFiles } from '@/lib/conn';
import { prefs } from '@/lib/prefs';
import { modKey } from '@/lib/format';
import { cn } from '@/lib/utils';
import { WORKSPACE_NAME } from '@shared/protocol';

function CopyBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative">
      <pre className="max-h-56 overflow-auto rounded-lg border bg-muted/50 p-3 pr-12 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all scrollbar-thin">{code}</pre>
      <Button
        size="icon-xs" variant="outline" aria-label="Copy"
        className="absolute right-2 top-2 bg-background"
        onClick={() => navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => toast.error('Copy failed; select the text instead'))}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function ConnectDialog() {
  const open = useStore(s => s.modal === 'connect');
  const preset = useStore(s => s.connectAgent);
  const workspaces = useStore(s => s.workspaces);
  const current = useStore(s => s.ws);
  const port = useStore(s => s.boot?.agentPort ?? 9230);
  const [agent, setAgent] = useState(prefs.get('agent', 'my-agent'));
  const [ws, setWs] = useState(current || 'default');
  useEffect(() => { if (open) { setWs(current || 'default'); if (preset) setAgent(preset); } }, [open, current, preset]);
  const name = (agent.trim() || 'my-agent').replace(/[^\w.-]/g, '-');
  const target = workspaces.find(w => w.name === ws);
  const connected = target?.agents.some(a => a.name === name);
  const hostPort = `127.0.0.1:${port}`;
  const ep = `ws://${hostPort}/${ws}/${name}/devtools/browser`;
  const snippets: [string, string, string][] = [
    ['claude', 'Claude Code', `claude mcp add browser -- npx -y chrome-devtools-mcp@latest \\\n  --wsEndpoint ${ep}`],
    ['codex', 'Codex', `codex mcp add browser -- npx -y chrome-devtools-mcp@latest \\\n  --wsEndpoint ${ep}`],
    ['json', 'MCP JSON', JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest', '--wsEndpoint', ep] } } }, null, 2)],
    ['playwright', 'Playwright', `import { chromium } from 'playwright';\n\nconst browser = await chromium.connectOverCDP('http://${hostPort}/${ws}/${name}');\nconst page = await browser.contexts()[0].newPage();`],
    ['puppeteer', 'Puppeteer', `import puppeteer from 'puppeteer-core';\n\nconst browser = await puppeteer.connect({\n  browserWSEndpoint: '${ep}',\n});\nconst page = await browser.newPage();`],
    ['url', 'Raw CDP', ep],
  ];
  const [tab, setTab] = useState(prefs.get('connectTab', 'claude'));
  return (
    <Dialog open={open} onOpenChange={o => !o && closeModal()}>
      <DialogContent className="gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Connect an agent</DialogTitle>
          <DialogDescription>
            Agents share the workspace’s logins but only see the tabs they open. Pick a name for each agent; its tabs show up in the sidebar as it works.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="agent-name">Agent name</Label>
            <Input id="agent-name" value={agent} spellCheck={false} autoCapitalize="off" onChange={e => { setAgent(e.target.value); prefs.set('agent', e.target.value); }} />
          </div>
          <div className="grid gap-1.5">
            <Label>Workspace</Label>
            <Select value={ws} onValueChange={setWs}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{workspaces.map(w => <SelectItem key={w.name} value={w.name}>{w.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <Tabs value={tab} onValueChange={v => { setTab(v); prefs.set('connectTab', v); }} className="min-w-0 gap-3">
          <TabsList className="h-auto w-full flex-wrap justify-start">
            {snippets.map(([k, label]) => <TabsTrigger key={k} value={k} className="flex-none px-2.5 text-xs">{label}</TabsTrigger>)}
          </TabsList>
          {snippets.map(([k, , code]) => <TabsContent key={k} value={k} className="min-w-0"><CopyBlock code={code} /></TabsContent>)}
        </Tabs>
        <div className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm', connected && 'border-signal/50 bg-signal-soft')}>
          {connected
            ? <><CheckCircle2 className="size-4 text-signal" /><span><span className="font-medium">{name}</span> is connected to “{ws}”.</span></>
            : <><Loader2 className="size-4 animate-spin text-muted-foreground" /><span className="text-muted-foreground">Waiting for <span className="font-medium text-foreground">{name}</span> to connect…</span></>}
          <AgentAvatar name={name} className="ml-auto" />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Run these on the machine where tabkennel runs: the agent port ({port}) only listens locally, and anything that reaches it is signed in as you.
          Naming a workspace that doesn’t exist creates it.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export function NewWorkspaceDialog() {
  const open = useStore(s => s.modal === 'newWorkspace');
  const [name, setName] = useState('');
  const valid = WORKSPACE_NAME.test(name);
  const exists = useStore(s => s.workspaces.some(w => w.name === name));
  const create = () => {
    if (!valid) return;
    closeModal(); setName('');
    switchWorkspace(name);
    toast.success(`Created “${name}”`, { description: 'It has its own logins. Sign in to sites here.' });
  };
  return (
    <Dialog open={open} onOpenChange={o => !o && closeModal()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>A separate browser profile: its own logins, cookies and tabs. For example “work” and “personal”.</DialogDescription>
        </DialogHeader>
        <form onSubmit={e => { e.preventDefault(); create(); }} className="grid gap-2">
          <Label htmlFor="ws-name">Name</Label>
          <Input id="ws-name" autoFocus value={name} onChange={e => setName(e.target.value.toLowerCase())} placeholder="work" maxLength={32} spellCheck={false} autoCapitalize="off" />
          <p className={cn('text-xs', name && !valid ? 'text-destructive' : 'text-muted-foreground')}>
            {exists ? 'That workspace exists; creating it opens it.' : 'Lowercase letters, numbers, - and _. Agents use it in their connection URL.'}
          </p>
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button type="submit" disabled={!valid}>{exists ? 'Open' : 'Create'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const IDLE: [string, string][] = [['default', 'Default'], ['2', '2 minutes'], ['5', '5 minutes'], ['10', '10 minutes'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['0', 'Never']];

export function SettingsDialog() {
  const open = useStore(s => s.modal === 'settings');
  const w = useStore(currentWorkspace);
  const def = useStore(s => s.boot?.idleMinutes ?? 10);
  const [confirm, setConfirm] = useState('');
  useEffect(() => { if (!open) setConfirm(''); }, [open]);
  if (!w) return null;
  const idleValue = w.customIdle ? String(w.idleMinutes) : 'default';
  return (
    <Dialog open={open} onOpenChange={o => !o && closeModal()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workspace “{w.name}”</DialogTitle>
          <DialogDescription>
            {w.state === 'awake' ? `Awake${w.memoryMB ? `, using ${w.memoryMB} MB` : ''}` : 'Asleep, using no memory'} · {w.tabs} tab{w.tabs === 1 ? '' : 's'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="flex items-start justify-between gap-6">
            <div>
              <Label>Sleep when unused for</Label>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">With no viewer open and no agent commands, the browser stops and frees its memory. Tabs come back on wake.</p>
            </div>
            <Select value={idleValue} onValueChange={v => { send({ t: 'idle', name: w.name, minutes: v === 'default' ? null : +v }); toast.success('Saved'); }}>
              <SelectTrigger className="w-40 shrink-0"><SelectValue /></SelectTrigger>
              <SelectContent>
                {IDLE.map(([v, l]) => <SelectItem key={v} value={v}>{v === 'default' ? `${l} (${def ? `${def} min` : 'never'})` : l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-6">
            <div>
              <Label>Put to sleep now</Label>
              <p className="mt-1 text-xs text-muted-foreground">Agents are disconnected; they reconnect and wake it when they need it.</p>
            </div>
            <Button variant="outline" disabled={w.state !== 'awake'} onClick={() => { send({ t: 'sleep', name: w.name }); closeModal(); }}>Sleep</Button>
          </div>
          {w.blocked.length > 0 && (
            <>
              <Separator />
              <div>
                <Label>Blocked agents</Label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {w.blocked.map(b => (
                    <span key={b} className="flex items-center gap-2 rounded-md border py-1 pl-1 pr-1.5 text-xs">
                      <AgentAvatar name={b} /> {b}
                      <Button size="xs" variant="ghost" onClick={() => send({ t: 'agent', name: b, action: 'unblock' })}>Unblock</Button>
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}
          {w.name !== 'default' && (
            <>
              <Separator />
              <div className="rounded-lg border border-destructive/30 p-3">
                <Label className="text-destructive">Delete this workspace</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Removes its browser profile: every login, cookie and saved tab. Type <span className="font-mono text-foreground">{w.name}</span> to confirm.</p>
                <div className="mt-3 flex gap-2">
                  <Input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={w.name} className="h-8" spellCheck={false} />
                  <Button size="sm" variant="destructive" disabled={confirm !== w.name}
                    onClick={() => { send({ t: 'delete', name: w.name }); closeModal(); toast(`Deleted “${w.name}”`); }}>
                    Delete forever
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PageDialog() {
  const d = useStore(s => s.dialog);
  const [text, setText] = useState('');
  useEffect(() => { if (d) setText(d.value); }, [d]);
  const reply = (accept: boolean) => {
    send({ t: 'dialog', accept, text: d?.type === 'prompt' ? text : undefined });
    set({ dialog: null });
    (document.querySelector('[data-stage]') as HTMLElement | null)?.focus();
  };
  const title = d && ({ alert: 'The page says', confirm: 'The page asks', prompt: 'The page asks', beforeunload: 'Leave this page?' }[d.type] || 'The page says');
  return (
    <Dialog open={!!d} onOpenChange={o => !o && reply(false)}>
      <DialogContent className="sm:max-w-md" onInteractOutside={e => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words text-foreground/90">{d?.message}</DialogDescription>
        </DialogHeader>
        {d?.type === 'prompt' && <Input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && reply(true)} />}
        <DialogFooter>
          {d?.type !== 'alert' && <Button variant="ghost" onClick={() => reply(false)}>Cancel</Button>}
          <Button autoFocus={d?.type !== 'prompt'} onClick={() => reply(true)}>{d?.type === 'beforeunload' ? 'Leave' : 'OK'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FileChooserDialog() {
  const chooser = useStore(s => s.chooser);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!chooser) { setFiles([]); setBusy(false); } }, [chooser]);
  const pick = (list: FileList | null) => {
    const arr = list ? [...list] : [];
    setFiles(chooser?.multiple ? arr : arr.slice(0, 1));
  };
  const submit = async () => {
    setBusy(true);
    try {
      const ids = await uploadFiles(files);
      send({ t: 'files', ids });
      set({ chooser: null });
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog open={!!chooser} onOpenChange={o => !o && set({ chooser: null })}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>The page wants {chooser?.multiple ? 'files' : 'a file'}</DialogTitle>
          <DialogDescription>Pick from this device. It’s uploaded to the workspace and handed to the page.</DialogDescription>
        </DialogHeader>
        <button
          onClick={() => input.current?.click()}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
          className={cn('grid place-items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center text-sm text-muted-foreground transition-colors hover:bg-accent/50', over && 'border-ring bg-accent/50')}
        >
          <Upload className="size-5" />
          {files.length ? <span className="text-foreground">{files.map(f => f.name).join(', ')}</span> : <span>Drop {chooser?.multiple ? 'files' : 'a file'} here or <span className="text-foreground underline underline-offset-4">browse</span></span>}
        </button>
        <input ref={input} type="file" hidden multiple={!!chooser?.multiple} onChange={e => pick(e.target.files)} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => set({ chooser: null })}>Cancel</Button>
          <Button disabled={!files.length || busy} onClick={submit}>{busy ? <Loader2 className="animate-spin" /> : <FileUp />} Upload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SHORTCUTS: [string, string[]][] = [
  ['Search tabs and actions', [modKey, 'K']],
  ['Focus the address bar', [modKey, 'L']],
  ['Show or hide the sidebar', [modKey, 'B']],
  ['Copy the page selection', [modKey, 'C']],
  ['Paste into the page', [modKey, 'V']],
  ['Keyboard shortcuts', ['?']],
];

export function ShortcutsDialog() {
  const open = useStore(s => s.modal === 'shortcuts');
  return (
    <Dialog open={open} onOpenChange={o => !o && closeModal()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Everything else you type goes to the page.</DialogDescription>
        </DialogHeader>
        <div className="divide-y">
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between py-2 text-sm">
              {label}
              <span className="flex gap-1">{keys.map(k => <kbd key={k} className="min-w-6 rounded-md border bg-muted px-1.5 py-0.5 text-center font-mono text-xs">{k}</kbd>)}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// keyboard shortcuts that work outside the page
export function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-stage]')) return; // the stage handles its own keys
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); set({ modal: get().modal === 'palette' ? null : 'palette' }); }
      else if (e.key === '?' && !typing && !get().modal) { e.preventDefault(); set({ modal: 'shortcuts' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
