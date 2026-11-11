import type { HTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import type { Tone } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { KindIcon, type Kind } from './kit';
import { Time } from './zone';

const KIND_NAME: Record<Kind, string> = { collection: 'Collection', lens: 'Lens', ring: 'Ring', token: 'Token', wallet: 'Wallet', transaction: 'Transaction' };

/**
 * A page's title, the trail back up to it, and whatever it states on the
 * right. A page about one thing names its `kind` first, as a symbol tile and a
 * word, so every such page reads the same way: what it is, then which one.
 * `part` is what it belongs to, such as its ring, as chips under the title.
 */
export function Head({ title, crumb = [], sub, kind, part, children }: {
  title: ReactNode;
  crumb?: { href: string; label: string }[];
  sub?: ReactNode;
  kind?: Kind;
  part?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-6 pb-4">
      <div className="flex min-w-0 items-start gap-3">
      {kind ? <span aria-hidden className="mt-0.5 grid size-11 shrink-0 place-items-center rounded-lg border bg-card text-foreground"><KindIcon kind={kind} className="size-6" /></span> : null}
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
        {kind ? <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{KIND_NAME[kind]}</p> : null}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {/* A full hash or address breaks where it must, so a phone never scrolls sideways for it. */}
        {sub ? <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{sub}</p> : null}
        {part ? <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">{part}</div> : null}
      </div>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
    </header>
  );
}

// Pulses only for a reader who has not asked for less motion.
const BONE = 'rounded bg-muted motion-safe:animate-pulse';

/**
 * What a page shows while its reads are still out: Head's outline, with the
 * kind of thing it will be already named, so a slow store reads as on its way
 * and the reader knows where they are going before it lands.
 */
export function Loading({ kind, list = false }: { kind: Kind; list?: boolean }) {
  return (
    <div role="status" aria-label={list ? `Loading these ${kind}s` : `Loading this ${kind}`}>
      <header className="pt-6 pb-4">
        <div className={cn('mb-2 h-3 w-32', BONE)} />
        <div className="flex items-center gap-2">
          <KindIcon kind={kind} className="size-5 text-muted-foreground" />
          <div className={cn('h-7 w-64 max-w-full', BONE)} />
        </div>
      </header>
      <div className={cn('h-24 rounded-lg', BONE)} />
      <div className="mt-10 flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className={cn('h-8', BONE)} />)}
      </div>
    </div>
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
      tone === 'cycle' ? 'border-cycle/30 bg-cycle-surface' : tone === 'ceiling' ? 'border-ceiling/30 bg-ceiling-surface' : tone === 'apart' ? 'border-dashed bg-card' : 'bg-card')}>
      <div className="min-w-0 max-w-3xl">
        <p className={cn('text-lg font-semibold', tone === 'cycle' ? 'text-cycle' : tone === 'ceiling' ? 'text-ceiling' : 'text-foreground')}>{title}</p>
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

/**
 * An exclusive choice among views of the same thing, as one bar of links. `label` says what is chosen.
 * The links do not prefetch: each is this page again, and a prefetch renders all of it.
 */
export function Segmented({ label, items }: { label: string; items: { key: string; href: string; label: string; current: boolean }[] }) {
  return (
    <nav aria-label={label} className="flex rounded-md border bg-card p-0.5 text-sm">
      {items.map((i) => (
        <Link key={i.key} href={i.href} prefetch={false} aria-current={i.current ? 'page' : undefined}
          className={cn('rounded px-3 py-1', i.current ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

/** What a status pill's colour says: working is blue, done is green, only a failure is the fault colour, a limit to lift (a missing key) is neutral with a border, and idle is plain grey. */
export type PillTone = 'working' | 'done' | 'fault' | 'limit' | 'idle';
const PILL_TONE: Record<PillTone, string> = {
  working: 'bg-focus/12 text-focus',
  done: 'bg-ok/12 text-ok',
  fault: 'bg-fault/12 text-fault',
  limit: 'border bg-muted text-foreground',
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
 * `href` is the page re-sorted, so the caller decides what a second press does. It does not prefetch: a
 * header row of them would render the page once a column.
 */
export function SortLink({ href, dir, title, className, children }: { href: string; dir: 'asc' | 'desc' | null; title?: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={false} title={title} aria-current={dir === null ? undefined : 'true'}
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
