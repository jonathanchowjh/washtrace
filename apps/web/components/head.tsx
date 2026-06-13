import type { ReactNode } from 'react';
import Link from 'next/link';
import { plural } from '@/lib/format';
import type { Notice } from '@/lib/status';
import { cn } from '@/lib/utils';

/** A page's title, the trail back up to it, and whatever it states on the right. */
export function Head({ title, crumb = [], sub, children }: {
  title: ReactNode;
  crumb?: { href: string; label: string }[];
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-6 pb-4">
      <div className="min-w-0">
        {crumb.length > 0 ? (
          <nav aria-label="Trail" className="mb-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
            {crumb.map((c) => (
              <span key={c.href} className="after:ml-1 after:content-['›'] last:after:content-none">
                <Link href={c.href} className="hover:text-foreground hover:underline">{c.label}</Link>
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {sub ? <p className="mt-1 text-sm text-muted-foreground">{sub}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
    </header>
  );
}

/** The mark that goes with every fault, so it is never colour alone. */
export function Warn({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={cn('inline-block size-4 shrink-0 fill-current', className)}>
      <path d="M10 2 1 18h18L10 2Zm-1 5h2v6H9V7Zm0 7h2v2H9v-2Z" fillRule="evenodd" />
    </svg>
  );
}

/** A failed read, said where its rows would be. Never an empty list. `doThis` is the one step that fixes it. */
export function Problem({ title, children, doThis = 'check that the store is running and reachable, then reload this page.' }: { title: string; children: ReactNode; doThis?: ReactNode }) {
  return (
    <div role="alert" className="my-5 max-w-2xl rounded-lg border border-fault/40 bg-fault-surface p-4">
      <p className="flex items-center gap-2 font-medium text-fault"><Warn />{title}</p>
      <div className="mt-1 text-body">{children}</div>
      <p className="mt-2 text-sm text-body"><b className="text-fault">Do this:</b> {doThis}</p>
    </div>
  );
}

/**
 * What the worker has to say, by how serious it is. Only "needs you" is loud:
 * a neutral card with a warning icon and a "Do this" line. "Working" shows
 * progress; "info" is muted. The heading counts needs-you items only, so
 * "Nothing needs you" is the normal state even while hours of work remain.
 */
export function Notices({ notices }: { notices: Notice[] }) {
  const needs = notices.filter((n): n is Extract<Notice, { severity: 'needs-you' }> => n.severity === 'needs-you');
  const rest = notices.filter((n): n is Exclude<Notice, { severity: 'needs-you' }> => n.severity !== 'needs-you');
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold text-foreground">{needs.length === 0 ? 'Nothing needs you' : `${plural(needs.length, 'thing')} ${needs.length === 1 ? 'needs' : 'need'} you`}</h2>
      {needs.map((n, i) => (
        <div key={i} role="alert" className="flex gap-3 rounded-lg border border-fault/40 bg-card p-3 text-sm">
          <Warn className="mt-0.5 size-5 text-fault" />
          <div>
            <p className="font-semibold text-foreground">{n.text}</p>
            <p className="mt-0.5"><b className="text-fault">Do this:</b> {n.href ? <Link className="underline" href={n.href}>{n.doThis}</Link> : n.doThis}</p>
          </div>
        </div>
      ))}
      {rest.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {rest.map((n, i) => (
            <li key={i} className={cn('flex items-start gap-2', n.severity === 'info' && 'text-muted-foreground')}>
              {n.severity === 'working'
                ? <span aria-hidden className="mt-1.5 size-2 shrink-0 animate-pulse rounded-full bg-focus" />
                : <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full border border-muted-foreground" />}
              <span>{n.text}{n.action ? <> <Link className="underline" href={n.action.href}>{n.action.label}</Link></> : null}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A section titled by the question it answers. `lead` says how it connects
 * to the rest of the page: what it explains, or what it qualifies.
 */
export function Section({ title, lead, aside, id, children }: { title: string; lead?: ReactNode; aside?: ReactNode; id?: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="max-w-3xl">
          <h2 className="text-base font-semibold">{title}</h2>
          {lead ? <p className="mt-0.5 text-sm text-muted-foreground">{lead}</p> : null}
        </div>
        {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** The one-line answer a page exists to give, in its verdict's hue. */
export function Answer({ tone, title, children, aside }: { tone: 'cycle' | 'money' | 'clean'; title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4 sm:p-5',
      tone === 'cycle' ? 'border-cycle/30 bg-cycle-surface' : tone === 'money' ? 'border-money/30 bg-money-surface' : 'bg-card')}>
      <div className="min-w-0 max-w-3xl">
        <p className={cn('text-lg font-semibold', tone === 'cycle' ? 'text-cycle' : tone === 'money' ? 'text-money' : 'text-foreground')}>{title}</p>
        {children ? <div className="mt-1 text-sm">{children}</div> : null}
      </div>
      {aside}
    </div>
  );
}

/** The same thing on other sites: its explorer and the marketplaces it trades on. Each opens in a new tab. */
export function Elsewhere({ links, className }: { links: { label: string; href: string }[]; className?: string }) {
  if (links.length === 0) return null;
  return (
    <nav aria-label="Elsewhere" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
      <span>See it on</span>
      {links.map((l) => <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="font-medium text-foreground hover:underline">{l.label} ↗</a>)}
    </nav>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">{children}</p>;
}
