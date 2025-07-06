import type { ReactNode } from 'react';
import type { CollectionRow } from '@washtrace/detect';
import { LENSES, lensList, plural } from '@/lib/format';
import { progress, type Coverage } from '@/lib/metrics';
import { Warn } from '@/components/head';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';

const PILL = {
  complete: 'bg-ok/12 text-ok',
  checking: 'bg-money/12 text-money',
  'catching-up': 'bg-money/12 text-money',
  starting: 'bg-muted text-muted-foreground',
} as const;

/** How far the reading under a collection's numbers has got, as one word or two. */
export function ReadingPill({ cov }: { cov: Coverage }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', PILL[cov.reading])}>
      <i aria-hidden className={cn('size-1.5 rounded-full bg-current', cov.reading !== 'complete' && 'animate-pulse')} />
      {cov.label}
    </span>
  );
}

/** What the reading's state means for the numbers: the sentence under the answer that says how far to trust it. */
export function trust(cov: Coverage): string {
  if (cov.reading === 'starting') return 'The worker is still finding where this collection begins, so there are no numbers yet.';
  if (cov.reading === 'catching-up') return `History is ${cov.blocks === null ? 'partly' : progress(cov.blocks)} read, so every share can still move either way.`;
  if (cov.floor.length > 0) return `${progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of)} of wallets checked for money so far, so ${lensList(cov.floor)} are floors: they can only rise.`;
  if (!cov.money) return 'Every transfer is read. Money links were not checked, so only Round trips ran.';
  return 'Every transfer to the finalized head is read, and every trading wallet checked for money.';
}

/**
 * The reading in one line, for the top of a collection: the step holding the
 * numbers back right now, how far along it is, and what that means for them.
 * Steps run in order, so a step already done is shown ticked before it: the
 * wallets are only checked once the transfers are read. The steps
 * themselves are further down the page.
 */
export function ReadingSummary({ cov, href }: { cov: Coverage; href: string }) {
  const stage = cov.reading === 'catching-up' ? { share: cov.blocks ?? 0, of: 'of its history read' }
    : cov.reading === 'checking' ? { share: cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of, of: 'of trading wallets checked for money' }
    : cov.reading === 'complete' ? { share: 1, of: 'read: every transfer, and every wallet the lenses need' }
    : null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-3">
      <div className="flex min-w-[14rem] flex-1 flex-wrap items-center gap-3">
        {cov.reading === 'checking' ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ok/12 px-2 py-0.5 text-xs font-medium text-ok">
            <span aria-hidden>✓</span>Transfers read<span aria-hidden className="ml-1 text-muted-foreground">→</span>
          </span>
        ) : null}
        <span className="text-xl font-semibold text-foreground tabular-nums">{stage === null ? '…' : progress(stage.share)}</span>
        <div className="min-w-[11rem] flex-1">
          <p className="text-xs text-muted-foreground">{stage === null ? 'Finding where the collection begins' : stage.of}</p>
          <div className="mt-1 max-w-md"><Bar share={stage?.share ?? 0} /></div>
        </div>
      </div>
      <p className="max-w-xl text-xs text-muted-foreground">{trust(cov)} <a href={href} className="whitespace-nowrap underline hover:text-foreground">The three steps ↓</a></p>
    </div>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <i className={cn('block h-full rounded-full', share >= 1 ? 'bg-ok' : 'bg-money')} style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
    </span>
  );
}

function Step({ n, title, figure, value, bar, affects, children }: { n: number; title: string; figure: ReactNode; value: ReactNode; bar?: number; affects: ReactNode; children?: ReactNode }) {
  return (
    <li className="relative flex flex-col gap-1 px-4 py-3.5">
      <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-4.5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums">{n}</span>{title}
      </p>
      <p className="text-xl font-semibold text-foreground tabular-nums">{figure}</p>
      {bar !== undefined ? <Bar share={bar} /> : null}
      <p className="text-xs tabular-nums">{value}</p>
      {children}
      <p className="mt-auto pt-1.5 text-xs text-muted-foreground"><span className="font-medium text-body">Affects </span>{affects}</p>
    </li>
  );
}

/**
 * The pipeline under the numbers, step by step, each saying which part of
 * the answer it holds up. Ingest, fund, analyze: the worker's three jobs,
 * seen from the collection. It leads the page, because it says how far to
 * trust everything after it.
 */
export function ReadingPanel({ c, cov }: { c: CollectionRow; cov: Coverage }) {
  const a = c.latest;
  return (
    <ol className="grid divide-y rounded-lg border bg-card md:grid-cols-3 md:divide-x md:divide-y-0">
      <Step
        n={1} title="Transfers read"
        figure={cov.blocks === null ? '…' : progress(cov.blocks)}
        bar={cov.blocks ?? 0}
        value={c.cursorBlock === null ? 'Finding the deployment block…'
          : cov.behind === 0 ? `${plural(c.transfers, 'transfer')}, through the finalized head (block ${c.cursorBlock.toLocaleString()})`
          : `${plural(c.transfers, 'transfer')} so far · block ${c.cursorBlock.toLocaleString()}, ${plural(cov.behind ?? 0, 'block')} to go`}
        affects="all three lenses. Unread history can move any share either way."
      >
        {c.error ? <p className="flex items-start gap-1 text-xs text-fault"><Warn className="size-3.5" />Last read failed: {c.error}</p> : null}
      </Step>
      <Step
        n={2} title="Wallets checked for money"
        figure={cov.money ? progress(cov.wallets.of === 0 ? 0 : cov.wallets.checked / cov.wallets.of) : 'Off'}
        bar={cov.money ? (cov.wallets.of > 0 ? cov.wallets.checked / cov.wallets.of : 0) : undefined}
        value={cov.money ? `${cov.wallets.checked.toLocaleString()} of ${cov.wallets.of.toLocaleString()} trading wallets, busiest first` : 'No funding source is set (WASHTRACE_ETHERSCAN_KEY).'}
        affects={<>{LENSES.AU.name} and {LENSES.AC.name}. An unchecked wallet hides its links, so their shares can only rise.</>}
      >
        {a && a.truncatedSearches > 0 ? <p className="text-xs text-money">{plural(a.truncatedSearches, 'money search')} stopped at the visit cap before following every hop.</p> : null}
      </Step>
      <Step
        n={3} title="Analyzed"
        figure={a === null ? 'Not yet' : <span className="text-base"><Time ms={a.ranAt} /></span>}
        value={a === null ? 'It runs once the first transfers are read.' : <>took {a.tookMs < 10_000 ? `${a.tookMs} ms` : a.tookMs < 120_000 ? `${(a.tookMs / 1000).toFixed(0)} s` : `${(a.tookMs / 60_000).toFixed(1)} min`}{c.stale ? <span className="text-money"> · new data waiting for the next run</span> : ' · nothing new since'}</>}
        affects="every number on this page: it turns steps 1 and 2 into them."
      >
        {a ? <p className="text-xs text-muted-foreground">Gaps in history: {(a.missingData * 100).toFixed(1)}% of changes of owner (skipped, never guessed).</p> : null}
      </Step>
    </ol>
  );
}
