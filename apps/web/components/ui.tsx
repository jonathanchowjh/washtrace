import type { HTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { plural } from '@/lib/format';
import type { Tone } from '@/lib/metrics';
import type { Notice } from '@/lib/status';
import { cn } from '@/lib/utils';
import { Time } from './time';

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

/** What a page says when the store did not answer. */
export const STORE_DOWN = 'The store did not answer';

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
 * "Nothing has failed." is the normal state even while hours of work remain.
 * It does not say the worker is reading: a missing key is an info notice, a
 * limit to lift, so the notices below the heading matter too.
 */
export function Notices({ notices }: { notices: Notice[] }) {
  const needs = notices.filter((n): n is Extract<Notice, { severity: 'needs-you' }> => n.severity === 'needs-you');
  const rest = notices.filter((n): n is Exclude<Notice, { severity: 'needs-you' }> => n.severity !== 'needs-you');
  return (
    <div className="space-y-2">
      <h2 className="text-lg font-semibold text-foreground">{needs.length === 0 ? 'Nothing has failed.' : `${plural(needs.length, 'thing')} ${needs.length === 1 ? 'needs' : 'need'} you`}</h2>
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

/** Said above the numbers when every job has stalled: they are as of the worker's last pass, and nothing is keeping them current. */
export function Silent({ silent }: { silent: { since: number | null } }) {
  return (
    <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-fault/40 bg-card p-3 text-sm">
      <Warn className="mt-0.5 size-5 text-fault" />
      <p className="font-semibold text-foreground">
        {silent.since === null
          ? 'The worker has not run yet, so nothing has been read.'
          : <>The worker has not reported since <Time ms={silent.since} />, so nothing on this page is being kept current.</>}
        {' '}<Link className="font-normal text-fault underline" href="/worker">See the worker →</Link>
      </p>
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
      <SectionHead title={title} lead={lead} aside={aside} />
      {children}
    </section>
  );
}

/** A section's heading alone, for a client component that lays out its own sections around state they share. */
export function SectionHead({ title, lead, aside }: { title: string; lead?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
      <div className="max-w-3xl">
        <h2 className="text-base font-semibold">{title}</h2>
        {lead ? <p className="mt-0.5 text-sm text-muted-foreground">{lead}</p> : null}
      </div>
      {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
    </div>
  );
}

/** The one-line answer a page exists to give, in its verdict's hue. */
export function Answer({ tone, title, children, aside }: { tone: Tone; title: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-4 rounded-lg border p-4 sm:p-5',
      tone === 'cycle' ? 'border-cycle/30 bg-cycle-surface' : tone === 'money' ? 'border-money/30 bg-money-surface' : tone === 'apart' ? 'border-dashed bg-card' : 'bg-card')}>
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
      {links.map((l) => <Ext key={l.href} href={l.href} className="font-medium text-foreground">{l.label}</Ext>)}
    </nav>
  );
}

/** A page's empty state: a dashed box saying what is missing and, where it helps, why. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">{children}</p>;
}

/** A link to another site: a new tab, no opener, and the arrow that says so. Null `href` (a chain with no explorer) leaves the text plain. */
export function Ext({ href, className, title, children }: { href: string | null; className?: string; title?: string; children: ReactNode }) {
  if (href === null) return <span className={className}>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={cn('hover:underline', className)}>{children} ↗</a>;
}

/** The link that leads on to more of what a section shows. Prose links ("Back to collections") stay plain underlined text. */
export function MoreLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <Link href={href} className={cn('inline-block text-sm font-medium text-foreground underline-offset-4 hover:underline', className)}>{children}</Link>;
}

/** An exclusive choice among views of the same thing, as one bar of links. `label` says what is chosen. */
export function Segmented({ label, items }: { label: string; items: { key: string; href: string; label: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex rounded-md border bg-card p-0.5 text-sm">
      {items.map((i) => (
        <Link key={i.key} href={i.href} aria-current={i.current ? 'page' : undefined}
          className={cn('rounded px-3 py-1', i.current ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/** What a status pill's colour says: working is blue, done is green, only a failure is the fault colour, a limit to lift (a missing key) is its own, and idle is grey. */
export type PillTone = 'working' | 'done' | 'fault' | 'limit' | 'idle';
const PILL_TONE: Record<PillTone, string> = {
  working: 'bg-focus/12 text-focus',
  done: 'bg-ok/12 text-ok',
  fault: 'bg-fault/12 text-fault',
  limit: 'bg-money/12 text-money',
  idle: 'bg-muted text-muted-foreground',
};

/** A status in one or two words. The radius is not full, so a pill that wraps in a narrow column stays a rounded box. */
export function Pill({ tone, className, children, ...rest }: { tone: PillTone; className?: string; children: ReactNode } & Pick<HTMLAttributes<HTMLSpanElement>, 'title' | 'aria-describedby'>) {
  return <span {...rest} className={cn('rounded-[10px] px-2 py-0.5 text-xs font-medium', PILL_TONE[tone], className)}>{children}</span>;
}

/** Progress as a thin bar. Never green when `paused` (a stage that is not done or following, or a frozen head): a full bar would claim it is current. */
export function Bar({ share, paused = false, name, className }: { share: number; paused?: boolean; name?: string; className?: string }) {
  return (
    <span aria-hidden data-bar={name} className={cn('block h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <i className={cn('block h-full rounded-full', share >= 1 && !paused ? 'bg-ok' : 'bg-muted-foreground')} style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
    </span>
  );
}

/**
 * A link that sorts by one thing. On the sort in force it says which way it runs (`dir`) with an arrow; elsewhere `dir` is null.
 * `href` is the page re-sorted, so the caller decides what a second press does.
 */
export function SortLink({ href, dir, title, className, children }: { href: string; dir: 'asc' | 'desc' | null; title?: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} title={title} aria-current={dir === null ? undefined : 'true'}
      className={cn('inline-flex items-center gap-1.5 hover:text-foreground hover:underline', dir !== null && `font-medium text-foreground after:text-[0.6rem] ${dir === 'asc' ? "after:content-['▲']" : "after:content-['▼']"}`, className)}>
      {children}
    </Link>
  );
}

/** A table's sortable column head: `aria-sort` on the column in force, and the link that sorts by it. */
export function SortHead({ href, dir, title, right = false, children }: { href: string; dir: 'asc' | 'desc' | null; title?: string; right?: boolean; children: ReactNode }) {
  return (
    <th aria-sort={dir === null ? undefined : dir === 'asc' ? 'ascending' : 'descending'} className={cn('px-3 py-2 font-medium', right ? 'text-right' : 'text-left')}>
      <SortLink href={href} dir={dir} title={title}>{children}</SortLink>
    </th>
  );
}
