import type { ReactNode } from 'react';
import Link from 'next/link';
import { type Lens, type LensRun, type Method, type MethodTotals } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { COPIES, ruleLine } from '@washtrace/detect/lens-rule';
import { LOCAL_ONLY } from '@/lib/auth';
import { ETHERSCAN_CTA, ETHERSCAN_HREF, LENSES, SHOWN, floorPct, pctTenth, type Lenses } from '@/lib/format';
import type { MoneyReason } from '@washtrace/detect/lens-reads';
import { behindOf, builtinCauses, causeSentence, runStateWords, shareCauses, shareQualifier, type Behind, type Qualifier, type TokensFloor } from '@/lib/lens-state';
import { APART, APART_WHY, ownLenses, part } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { DeleteLens, RunHere } from './lens-actions';
import { LensName, LensPicture, TierWord } from './methods';
import { RuleTable } from './rule-table';
import { Time } from './zone';
import { lensTabHref } from '@/lib/links';

type Runs = readonly { lens: Lens; run: LensRun | null }[];

/** What the next analysis has to run the money lenses on, for a built-in that has not run. */
interface Funding {
  /** This collection loaded a money trail from stored data. */
  trail: boolean;
  /** The next analysis has funding to run the money lenses on: a key, or this collection's trail with checked wallets. */
  funded: boolean;
  /** An Etherscan key is set (SourcesConfig.funding): only a key checks the wallets a trail left unchecked. */
  funding: boolean;
  /** A stored money trail with checked wallets is on its way (trailComing): the money lenses run on it once it has loaded. */
  coming: boolean;
  /** No pass has reported (workerSilent): a trail on its way loads only once the worker reports again. */
  silent: boolean;
}

const ACCENT = { cycle: 'border-t-cycle', ceiling: 'border-t-ceiling', apart: 'border-t-muted-foreground', own: 'border-t-flow' } as const;

/** No token cause: a lens the page gave no tokens figure for. */
const NO_TOKENS: TokensFloor = { reason: null, payees: false };

/**
 * The collection page's lenses as tabs: the three built-ins, yours beside
 * them, and + New lens; under the strip, the panel of the chosen one. Each
 * tab says where its run stands, and the chosen tab has no bottom edge and
 * runs into the panel, so what is listed is visibly that tab's. `totals` is
 * the latest analysis's, null before the first, and `latestId` its id, which
 * a run of yours is behind when it is not from it.
 */
export function LensTabs({ base, chainId, address, selected, totals, latestId, paused, runs, notFinal, moneyReasons, tokens, coverage, writable, editor = null, drafting = false, children }: {
  base: string; chainId: number; address: string; selected: LensKey | 'compare';
  totals: Record<Method, MethodTotals> | null; latestId: number | null;
  /** The collection is paused: the worker runs no lens on it until it is resumed. */
  paused: boolean;
  runs: Runs; notFinal: readonly Method[];
  /** By lens key: why the collection's money is not read as far as that lens needs, or null (moneyReason of lens-reads). */
  moneyReasons: Readonly<Record<string, MoneyReason | null>>;
  /** By lens key: whether the collection's other tokens are read as far as that lens needs (tokensReason of lens-reads), and the setting the count was made under. */
  tokens: Readonly<Record<string, TokensFloor>>;
  coverage: Funding; writable: boolean;
  /** The lens editor, when `?lens=` asks for one: it takes the panel's place, under the same tab. */
  editor?: ReactNode;
  /** The editor makes a new lens (+ New lens, or a copy), so + New lens is the tab lit over it, not the lens it started from. */
  drafting?: boolean;
  /** The chosen lens's stat line and lists; the panel shows them for a built-in, and for a lens of yours once it has figures. On the Compare tab, the comparison. */
  children: ReactNode;
}) {
  const href = (key: string) => lensTabHref(base, key);
  const own = ownLenses(runs);
  const chosen = runs.find((r) => r.lens.key === selected) ?? null;
  const tone = chosen || selected === 'compare' || drafting ? 'own' : LENSES[selected as Method].tone;
  // While a new lens is drafted, its tab is the lit one: the panel under it is the editor, not the chosen lens.
  const lit = drafting ? null : selected;

  return (
    <div>
      <nav aria-label="Lens" className="flex flex-wrap gap-2">
        {SHOWN.map((m) => {
          const t = totals?.[m];
          const on = m === lit;
          return (
            <Tab key={m} href={href(m)} on={on} tone={LENSES[m].tone} title={`Show what ${LENSES[m].name} flags`}>
              {/* Its standing under the name, as the overview's ladder says it, so a tab never reads as just another lens. */}
              <span className="flex flex-col">
                <span className="flex items-baseline gap-2">
                  <LensName m={m} />
                  {t?.available ? <>{' '}<Share t={t} qualifier={shareQualifier(builtinCauses(m, notFinal, coverage.funded, coverage.funding))} /></> : totals ? <>{' '}<span className="text-xs text-muted-foreground">{runStateWords(null)!.short}</span></> : null}
                </span>
                {' '}<TierWord m={m} className="pl-4" />
              </span>
            </Tab>
          );
        })}
        {runs.map(({ lens, run }) => {
          const t = run?.totals ?? null;
          const word = runStateWords(run, behindOf(run, lens, latestId === null ? null : { id: latestId }))?.short;
          return (
            <Tab key={lens.key} href={href(lens.key)} on={lens.key === lit} tone="own" title={`Show what ${lens.name} flags`}>
              <LensName m={lens.key} own={own} />
              {t ? <>{' '}<Share t={t} qualifier={shareQualifier(shareCauses(lens.rule, t, notFinal, coverage.funded, coverage.funding, moneyReasons[lens.key] ?? null, tokens[lens.key] ?? NO_TOKENS))} /></> : null}
              {word ? <>{' '}<span className="text-xs text-muted-foreground">{word}</span></> : null}
            </Tab>
          );
        })}
        {/* A tab like the others, on their line and of their height, so it can be the lit one while its editor is open. */}
        {writable
          ? <Tab href={lensTabHref(base, selected, { lens: 'new' })} on={drafting} tone="own" title="Write a lens of your own">+ New lens</Tab>
          : <button type="button" disabled title={LOCAL_ONLY} className={cn(TAB, 'border-t-border bg-muted/50 text-muted-foreground disabled:cursor-not-allowed')}>+ New lens</button>}
        <Tab href={href('compare')} on={lit === 'compare'} tone="own" title="Compare how many sales each pair of lenses both caught">Compare</Tab>
      </nav>
      <section
        data-lens-panel aria-label={drafting ? 'New lens' : selected === 'compare' ? 'Compare lenses' : `${chosen ? chosen.lens.name : LENSES[selected as Method].name} lens`}
        className={cn('rounded-lg rounded-tl-none border border-t-[3px] bg-card p-4', ACCENT[tone])}
      >
        {editor ?? (selected === 'compare' ? children : chosen
          ? <YourLens base={base} chainId={chainId} address={address} lens={chosen.lens} own={own} run={chosen.run} analyzed={totals !== null}
            behind={behindOf(chosen.run, chosen.lens, latestId === null ? null : { id: latestId })} paused={paused} writable={writable} notFinal={notFinal} funded={coverage.funded} funding={coverage.funding} money={moneyReasons[chosen.lens.key] ?? null} tokens={tokens[chosen.lens.key] ?? NO_TOKENS}>{children}</YourLens>
          : <BuiltIn base={base} m={selected as Method} t={totals?.[selected as Method] ?? null} coverage={coverage} writable={writable}>{children}</BuiltIn>)}
      </section>
    </div>
  );
}

// On a phone the tabs wrap; each grows so a row fills the width, rather than leaving Compare a stub on its own.
const TAB = 'flex items-baseline gap-2 rounded-t-lg border border-t-[3px] px-3 py-2 text-sm transition-colors max-sm:grow';

function Tab({ href, on, tone, title, children }: { href: string; on: boolean; tone: keyof typeof ACCENT; title: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={false} scroll={false} title={title} aria-current={on ? 'page' : undefined}
      className={cn(TAB, on ? cn('-mb-px border-b-0 bg-card pb-3', ACCENT[tone]) : 'border-t-border bg-muted/50 hover:bg-card')}>
      {children}
    </Link>
  );
}

/** A share with its qualifier: "at least" before the figure, "so far" after it. */
function Share({ t, qualifier }: { t: MethodTotals; qualifier: Qualifier | null }) {
  const s = part(t, 'sales');
  return (
    <>
      <span className="font-semibold tabular-nums text-foreground">{qualifier === 'at least' ? 'at least ' : ''}{pctTenth(s.part, s.whole)}</span>
      {qualifier === 'so far' ? <>{' '}<span className="text-xs text-muted-foreground">so far</span></> : null}
    </>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{children}</span>;
}

/** A control that is a link while the console may write, and a disabled button saying why while it may not. */
function Action({ href, writable, children }: { href: string; writable: boolean; children: string }) {
  return writable
    ? <Link href={href} scroll={false} className="btn text-xs">{children}</Link>
    : <button type="button" disabled title={LOCAL_ONLY} className="btn text-xs">{children}</button>;
}

function BuiltIn({ base, m, t, coverage, writable, children }: {
  base: string; m: Method; t: MethodTotals | null; coverage: Funding; writable: boolean; children: ReactNode;
}) {
  const { trail, funded, coming, silent } = coverage;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <LensName m={m} className="text-base" />
          <Chip>built in · read-only</Chip>
        </div>
        <Action href={lensTabHref(base, m, { lens: `copy-${m}` })} writable={writable}>Copy to new lens</Action>
      </div>
      <div className="mb-3 flex items-start gap-3">
        <LensPicture m={m} />
        <p className="text-sm text-muted-foreground">{LENSES[m].says}</p>
      </div>
      {APART.includes(m) ? <p className="mb-3 text-xs text-muted-foreground">Not in the range above: {APART_WHY}.</p> : null}
      {t && !t.available ? (
        <p className="mb-3 text-sm text-muted-foreground">
          {coming && !funded
            ? `Not run yet. A stored money trail is on its way, and the first analysis after it loads runs this lens on it${silent ? ', once the worker reports again' : ''}.`
            : funded
            ? (trail ? 'Not run yet. The stored money trail is loaded, so it says who paid whom, and the next analysis runs this lens on it.' : 'Not run yet. A funding source is set, and the next analysis runs this lens.')
            : <>Not run. {trail ? 'The stored money trail checked no wallet' : 'It needs to know who paid whom'}, and it needs an Etherscan key (<code className="font-mono text-xs">WASHTRACE_ETHERSCAN_KEY</code>). <Link href={ETHERSCAN_HREF} className="underline">{ETHERSCAN_CTA}</Link></>}
        </p>
      ) : null}
      <details className="mb-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground" title={`The rule ${LENSES[m].name} follows, as the editor would set it`}>
          Its rule, read-only: {ruleLine(COPIES[m].rule)}
        </summary>
        <div className="mt-3"><RuleTable rule={COPIES[m].rule} /></div>
      </details>
      {children}
    </>
  );
}

function YourLens({ base, chainId, address, lens, own, run, analyzed, behind, paused, writable, notFinal, funded, funding, money, tokens, children }: {
  base: string; chainId: number; address: string; lens: Lens; own: Lenses; run: LensRun | null; analyzed: boolean;
  behind: Behind | null; paused: boolean; writable: boolean; notFinal: readonly Method[]; funded: boolean; funding: boolean; money: MoneyReason | null; tokens: TokensFloor; children: ReactNode;
}) {
  const t = run?.totals ?? null;
  // Why its share is weaker than it reads, in the words the tab, the stat line and the chart's title go by, with the counts the panel has room for.
  const why = t === null ? null : causeSentence(shareCauses(lens.rule, t, notFinal, funded, funding, money, tokens, true));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <LensName m={lens.key} own={own} className="text-base" />
          <Chip>yours</Chip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Action href={lensTabHref(base, lens.key, { lens: `edit-${lens.key}` })} writable={writable}>Edit</Action>
          <DeleteLens id={lens.id} name={lens.name} writable={writable} />
        </div>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{ruleLine(lens.rule)}</p>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <RunLine name={lens.name} run={run} analyzed={analyzed} behind={behind} paused={paused} />
        {/* No run here, or one that failed (after three in a row it waits to be asked): a queued or running one is on its way, and a done one runs again on its own. */}
        {run === null || run.status === 'failed' ? <RunHere id={lens.id} chainId={chainId} address={address} writable={writable} /> : null}
      </div>
      {t ? (
        <>
          {why !== null ? <p className="mb-3 text-sm text-muted-foreground">{why}</p> : null}
          {children}
        </>
      ) : null}
    </>
  );
}

/**
 * Where a lens of yours's run stands, in the sentence every page says for
 * that state (runStateWords) and then what only this panel knows: why it is
 * waiting, how far it has got, the error and the retry. Nothing for a finished
 * run that is current. A paused collection runs no lens, so a run waiting on
 * it says so.
 */
function RunLine({ name, run, analyzed, behind, paused }: { name: string; run: LensRun | null; analyzed: boolean; behind: Behind | null; paused: boolean }) {
  const words = runStateWords(run, behind);
  if (words === null) return null;
  const said = `${name} ${words.full}`;
  const resumed = 'It waits for this collection to be resumed.';
  if (run === null) return <p className="text-muted-foreground">{said}</p>;
  switch (run.status) {
    case 'queued':
      return <p className="text-muted-foreground">{said} {paused ? resumed : run.totals !== null ? null : analyzed ? 'The worker runs it next.' : "It waits for this collection's first analysis."}</p>;
    case 'running':
      return <p className="text-muted-foreground">{said}{run.progress === null ? '' : ` It is ${floorPct(run.progress, 1)} done.`}</p>;
    case 'failed':
      return (
        <p className="text-fault">
          {said} The error: {(run.error ?? 'no reason was kept').replace(/\.$/, '')}.
          {run.retryAt === null ? ' It is not tried again until you run it here or edit it.' : <> It is tried again <Time ms={run.retryAt} />.</>}
        </p>
      );
    default:
      // Done: behind only once a newer analysis landed and the re-run gap has not passed, or an edit raced its save.
      return <p className="text-muted-foreground">{said}{behind === 'analysis' ? (paused ? ' It runs again once this collection is resumed.' : ' It runs again on the latest analysis soon.') : ''}</p>;
  }
}
