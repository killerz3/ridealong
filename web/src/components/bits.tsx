// Small pieces used across the app.
import { useState } from 'react';
import { Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { agentColor, agentTint, initials, isBlank } from '@/lib/format';
import type { WorkspaceInfo } from '@shared/protocol';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M3.5 10.5 12 4l8.5 6.5V20h-17z" />
      <path d="M9.25 20v-3.75a2.75 2.75 0 0 1 5.5 0V20" />
    </svg>
  );
}

// the dot is the current workspace's state: lit while its browser runs
export function Logo({ className, state = 'awake' }: { className?: string; state?: WorkspaceInfo['state'] }) {
  return (
    <div className={cn('relative grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground', className)}>
      <LogoMark className="size-[18px]" />
      <span className={cn('absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-sidebar transition-colors',
        state === 'awake' ? 'bg-signal' : state === 'asleep' ? 'bg-muted-foreground' : 'bg-warn')} />
    </div>
  );
}

export function AgentAvatar({ name, className, live }: { name: string; className?: string; live?: boolean }) {
  return (
    <span
      className={cn('relative grid size-5 shrink-0 place-items-center rounded-md text-[9.5px] font-semibold tracking-tight', className)}
      style={{ background: agentTint(name), color: agentColor(name) }}
      aria-hidden
    >
      {initials(name)}
      {live && <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-[1.5px] border-sidebar bg-signal" />}
    </span>
  );
}

export function Favicon({ url, className }: { url: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const web = /^https?:/.test(url);
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  if (!web || isBlank(url) || failed === origin) {
    return <Globe className={cn('size-4 shrink-0 text-muted-foreground/70', className)} aria-hidden />;
  }
  return (
    <img
      src={`/api/favicon?url=${encodeURIComponent(origin)}`}
      onError={() => setFailed(origin)}
      className={cn('size-4 shrink-0 rounded-[3px] object-contain', className)}
      alt=""
      loading="lazy"
    />
  );
}

export function StateDot({ w, className }: { w: Pick<WorkspaceInfo, 'state' | 'error'>; className?: string }) {
  const tone = w.error && w.state === 'asleep' ? 'bg-destructive'
    : w.state === 'awake' ? 'bg-signal'
    : w.state === 'asleep' ? 'bg-muted-foreground/40'
    : 'bg-warn animate-pulse';
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', tone, className)} aria-hidden />;
}

export function Shortcut({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn('ml-auto inline-flex items-center gap-0.5 font-mono text-[10.5px] text-muted-foreground', className)}>
      {keys.map(k => <kbd key={k} className="rounded border bg-background/60 px-1 py-px leading-none">{k}</kbd>)}
    </span>
  );
}
