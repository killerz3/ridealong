import { useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/bits';

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(location.search.includes('wrong') ? 'That password didn’t work.' : '');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await fetch('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
      if (r.ok) { history.replaceState(null, '', location.pathname + location.hash); return onDone(); }
      setError('That password didn’t work.');
    } catch { setError('Can’t reach ridealong. Is it running?'); }
    setBusy(false);
  };
  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-background p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <Logo className="size-10 [&_svg]:size-5 [&>span]:border-background" />
          <div>
            <div className="text-lg font-semibold tracking-tight">ridealong</div>
            <div className="text-sm text-muted-foreground">One logged-in browser for you and your agents</div>
          </div>
        </div>
        <form onSubmit={submit} className="rounded-2xl border bg-card p-6 shadow-sm">
          <label htmlFor="password" className="text-sm font-medium">Password</label>
          <Input id="password" name="password" type="password" autoFocus autoComplete="current-password" value={password}
            onChange={e => setPassword(e.target.value)} className="mt-2 h-10" aria-invalid={!!error} />
          <p className="mt-2 min-h-5 text-xs text-destructive" role="alert">{error}</p>
          <Button type="submit" className="mt-2 h-10 w-full" disabled={!password || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <>Sign in <ArrowRight /></>}
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">Forgot it? Run <code className="rounded bg-muted px-1 py-0.5 font-mono">ridealong password</code> on the server.</p>
      </div>
    </main>
  );
}
