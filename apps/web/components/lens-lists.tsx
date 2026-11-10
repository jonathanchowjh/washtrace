import Link from 'next/link';
import type { TokenLine, WalletLine } from '@washtrace/detect';
import { findOf, isOwnKey, type LensKey } from '@washtrace/detect/trades';
import { eth, lensInfo, num, plural, tokenLabel, type Lenses } from '@/lib/format';
import { tradesHref } from '@/lib/trades-url';
import { SORTS } from '@/lib/params';
import { tokenWhy, walletWhy, type WhyPart } from '@/lib/why';
import { cn } from '@/lib/utils';
import { Empty } from './ui';
import { Pager } from './pager';
import { Wallet } from './transfers';
import { HoverCard } from './hover-card';
import { FILL, FunnelIcon, KindIcon } from './kit';
import { cardSrc, withFrom } from '@/lib/links';

/**
 * The tokens or wallets one lens flagged trades of, each saying why in words,
 * with every count a link to the trades it counts: the loops to the token
 * page with them lit (or to a wallet's flagged trades), the wallets to their
 * group, the flagged and the total to those trades. A token opens its page
 * (a lens of yours's with its loops lit). Above it, the orders and a
 * Find box that keeps every other parameter; below it, its pages. A Find that
 * names nothing this list holds says so.
 */
export function LensList({ kind, method, own = {}, base, chainId, rows, total, of, sort, sortHref, find, findParam, pager, empty, from }: {
  kind: 'tokens' | 'wallets'; method: LensKey;
  /** Your lenses by key, for the name of a list that is one of them. */
  own?: Lenses; base: string; chainId: number; rows: TokenLine[] | WalletLine[]; total: number;
  /** How many the list holds with no Find. */
  of: number;
  sort: string; sortHref: (s: string) => string; find: string | null; findParam: string;
  pager: { page: number; size: number; href: (p: number) => string; param?: string }; empty: string;
  /** The list as an item's `from` (lib/step.ts), so an item opened from it can step to its neighbours. */
  from?: string;
}) {
  const lens = lensInfo(method, own);
  if (lens === null) return null;
  const unit = kind === 'tokens' ? 'token' : 'wallet';
  const yours = isOwnKey(method);
  // The Find form carries every parameter the first page's link does, except its own.
  const first = new URL(pager.href(1), 'http://list.invalid');
  const kept = [...first.searchParams].filter(([k]) => k !== findParam);
  first.searchParams.delete(findParam);
  const clear = `${first.pathname}${first.search}${first.hash}`;
  const named = find === null ? null : findOf(find);
  const readable = named === null || (kind === 'tokens' ? named.kind === 'token' : named.kind === 'address' || named.kind === 'prefix');
  const start = (pager.page - 1) * pager.size;

  return (
    <section aria-label={`${kind === 'tokens' ? 'Tokens' : 'Wallets'} ${lens.name} flagged`}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
        <h3 className="text-sm font-medium text-body">Which {unit}s did {lens.name} flag?</h3>
        <span>flagged of its counted trades · volume flagged</span>
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <nav aria-label={`Order the ${unit}s`} className="text-muted-foreground">
          Sort by{' '}
          {SORTS[kind].map(([s, label], i) => (
            <span key={s}>
              {i > 0 ? ' · ' : ''}
              <Link href={sortHref(s)} prefetch={false} aria-current={s === sort ? 'true' : undefined} className={cn('hover:underline', s === sort ? 'font-medium text-foreground' : '')}>{label}</Link>
            </span>
          ))}
        </nav>
        <form action={`${first.pathname}${first.hash}`} method="get" role="search" className="flex items-center gap-1.5">
          {kept.map(([k, v], i) => <input key={i} type="hidden" name={k} value={v} />)}
          <FunnelIcon className="text-muted-foreground" />
          <input
            type="search" name={findParam} defaultValue={find ?? ''} placeholder={kind === 'tokens' ? 'Find a token number' : 'Find a wallet (0x…)'}
            aria-label={kind === 'tokens' ? `Find a token ${lens.name} flagged, by its number` : `Find a wallet ${lens.name} flagged, by its address or the start of it`}
            className="field w-44"
          />
          <button type="submit" className="btn-secondary">Find</button>
        </form>
      </div>
      {find !== null ? (
        <MatchLine n={total} of={plural(of, unit)} query={find} clear={clear}>
          {readable ? null : <> · “{find}” is {kind === 'tokens' ? 'not a token number.' : 'not a wallet address or the start of one.'}</>}
        </MatchLine>
      ) : null}
      {rows.length === 0 ? (
        find === null ? <Empty>{empty}</Empty> : null
      ) : (
        <ol start={start + 1} className="rounded-lg border bg-card">
          {kind === 'tokens'
            ? (rows as TokenLine[]).map((l, i) => (
              <Row key={l.tokenId} n={start + i + 1} line={l} tone={lens.tone} why={tokenWhy(method, l)}
                // A lens of yours opens the token page with its loops lit, down at the why section.
                name={<HoverCard src={cardSrc(base, 'token', l.tokenId)}><Link href={withFrom(yours ? `${base}/t/${l.tokenId}?method=${method}#why` : `${base}/t/${l.tokenId}`, from)} prefetch={false} title={yours ? `Token #${l.tokenId}, with the loops ${lens.name} found lit` : `Token #${l.tokenId}`} className="inline-flex items-center gap-1.5 font-mono font-medium text-foreground hover:underline"><KindIcon kind="token" className="size-3.5 text-muted-foreground" />#{tokenLabel(l.tokenId)}</Link></HoverCard>}
                loops={withFrom(`${base}/t/${l.tokenId}?method=${method}${yours ? '#why' : ''}`, from)}
                group={tradesHref(base, { kind: 'all', group: { method, token: l.tokenId } })}
                trades={tradesHref(base, { kind: 'all', token: l.tokenId })}
                caught={tradesHref(base, { kind: 'all', caught: [method], token: l.tokenId })}
                volume={tradesHref(base, { kind: 'all', caught: [method], token: l.tokenId, sort: 'price', dir: 'desc' })}
              />
            ))
            : (rows as WalletLine[]).map((l, i) => (
              <Row key={l.address} n={start + i + 1} line={l} tone={lens.tone} why={walletWhy(method, l)}
                // Wallet draws the link alone, so its mark sits just before it.
                name={<span className="inline-flex items-center gap-1.5"><KindIcon kind="wallet" className="size-3.5 text-muted-foreground" /><Wallet chainId={chainId} address={l.address} within={base} from={from} /></span>}
                loops={tradesHref(base, { kind: 'all', caught: [method], wallet: l.address })}
                group={tradesHref(base, { kind: 'all', group: { method, wallet: l.address } })}
                trades={tradesHref(base, { kind: 'all', wallet: l.address })}
                caught={tradesHref(base, { kind: 'all', caught: [method], wallet: l.address })}
                volume={tradesHref(base, { kind: 'all', caught: [method], wallet: l.address, sort: 'price', dir: 'desc' })}
              />
            ))}
        </ol>
      )}
      {total > 0 ? <Pager total={total} page={pager.page} size={pager.size} href={pager.href} label={`${unit}s`} pageParam={pager.param} /> : null}
    </section>
  );
}

/**
 * What a Find or a filter left of a list: "12 of 644 tokens match “14” · Clear".
 * `of` names what was filtered, with its count. `query` is the Find text, null for a filter that has none to quote;
 * `clear` is the link back to the whole list. `children` follow, for a note on the query.
 */
export function MatchLine({ n, of, query, clear, children }: { n: number; of: string; query: string | null; clear: string; children?: React.ReactNode }) {
  return (
    <p className="mb-2 text-sm text-muted-foreground">
      {num(n)} of {of} {n === 1 ? 'matches' : 'match'}{query === null ? null : <> “{query}”</>} · <Link href={clear} className="font-medium text-foreground hover:underline">Clear</Link>
      {children}
    </p>
  );
}

/** One row: its number, its name, why in words, its flagged of its trades, its flagged volume, and the share as a bar in the lens's hue. */
function Row({ n, line, tone, why, name, loops, group, trades, caught, volume }: {
  n: number; line: TokenLine | WalletLine; tone: keyof typeof FILL; why: WhyPart[]; name: React.ReactNode; loops: string; group: string; trades: string; caught: string; volume: string;
}) {
  const number = 'font-medium text-foreground hover:underline';
  return (
    <li className="border-b px-3 py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span data-row-number className="w-7 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{n}</span>
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          <Link href={caught} prefetch={false} title="The trades it flagged" className={number}>{num(line.caught)}</Link>
          {' of '}
          <Link href={trades} prefetch={false} title="All its counted trades" className={number}>{num(line.trades)}</Link>
          {' trades'}
        </span>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums" title="Volume of the flagged sales priced in ETH or WETH">
          {line.volumeWei === '0' ? '—' : <Link href={volume} prefetch={false} title="The trades it flagged, biggest first" className={number}>{eth(line.volumeWei)}</Link>}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-3 pl-9">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {why.map((p, i) => p.opens === undefined ? <span key={i}>{p.text}</span> : (
            <Link key={i} href={p.opens === 'loops' ? loops : group} prefetch={false} className="text-foreground hover:underline">{p.text}</Link>
          ))}
        </p>
        <span aria-hidden className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
          <i className={cn('block h-full rounded-full', FILL[tone])} style={{ width: `${(line.caught / Math.max(1, line.trades)) * 100}%` }} />
        </span>
      </div>
    </li>
  );
}
