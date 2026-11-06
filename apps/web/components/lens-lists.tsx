import Link from 'next/link';
import type { Method, TokenLine, WalletLine } from '@washtrace/detect';
import { findOf } from '@washtrace/detect/trades';
import { LENSES, eth, plural } from '@/lib/format';
import { tradesHref } from '@/lib/trades';
import { tokenWhy, walletWhy, type WhyPart } from '@/lib/why';
import { cn } from '@/lib/utils';
import { DOT } from './methods';
import { Pager } from './pager';
import { Wallet } from './transfers';

/** Each list's orders, as the URL names them and as its sort links read. */
export const SORTS = {
  tokens: [['caught', 'most caught'], ['share', 'share'], ['volume', 'volume'], ['newest', 'newest']],
  wallets: [['caught', 'most caught'], ['share', 'share'], ['volume', 'volume'], ['first', 'first seen']],
} as const;

/** A list's page, order and Find from the URL. Junk is dropped: an unknown order is the default, and a page under 1 is the first. */
export function listView(kind: 'tokens' | 'wallets', raw: { page?: string; sort?: string; find?: string }): { page: number; sort: string; find: string | null } {
  const page = Number.parseInt(raw.page ?? '1', 10);
  return {
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    sort: SORTS[kind].some(([s]) => s === raw.sort) ? raw.sort! : 'caught',
    find: raw.find?.trim().slice(0, 100) || null,
  };
}

/** Page `asked` of a list, or its last when `asked` is past the end: the first read's count says where the end is. */
export async function clampedPage<T>(asked: number, size: number, read: (offset: number) => Promise<{ rows: T[]; total: number }>): Promise<{ rows: T[]; total: number; page: number }> {
  const first = await read((asked - 1) * size);
  if (first.rows.length > 0 || first.total === 0) return { ...first, page: asked };
  const page = Math.max(1, Math.ceil(first.total / size));
  return { ...(await read((page - 1) * size)), page };
}

/**
 * The tokens or wallets one lens caught trades of, each saying why in words,
 * with every count a link to the trades it counts: the loops to the token
 * page with them lit (or to a wallet's caught trades), the wallets to their
 * group, the caught and the total to those trades. Above it, the orders and a
 * Find box that keeps every other parameter; below it, its pages. A Find that
 * names nothing this list holds says so.
 */
export function LensList({ kind, method, base, chainId, rows, total, of, sort, sortHref, find, findParam, pager, empty }: {
  kind: 'tokens' | 'wallets'; method: Method; base: string; chainId: number; rows: TokenLine[] | WalletLine[]; total: number;
  /** How many the list holds with no Find. */
  of: number;
  sort: string; sortHref: (s: string) => string; find: string | null; findParam: string;
  pager: { page: number; size: number; href: (p: number) => string; param?: string }; empty: string;
}) {
  const lens = LENSES[method];
  const unit = kind === 'tokens' ? 'token' : 'wallet';
  // The Find form carries every parameter the first page's link does, except its own.
  const first = new URL(pager.href(1), 'http://list.invalid');
  const kept = [...first.searchParams].filter(([k]) => k !== findParam);
  first.searchParams.delete(findParam);
  const clear = `${first.pathname}${first.search}${first.hash}`;
  const named = find === null ? null : findOf(find);
  const readable = named === null || (kind === 'tokens' ? named.kind === 'token' : named.kind === 'address' || named.kind === 'prefix');
  const start = (pager.page - 1) * pager.size;

  return (
    <section aria-label={`${kind === 'tokens' ? 'Tokens' : 'Wallets'} ${lens.name} caught`}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-muted-foreground">
        <h3 className="text-sm font-medium text-body">Which {unit}s did {lens.name} catch?</h3>
        <span>caught of its counted trades · volume caught</span>
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <nav aria-label={`Order the ${unit}s`} className="text-muted-foreground">
          Sort by{' '}
          {SORTS[kind].map(([s, label], i) => (
            <span key={s}>
              {i > 0 ? ' · ' : ''}
              <Link href={sortHref(s)} aria-current={s === sort ? 'true' : undefined} className={cn('hover:underline', s === sort ? 'font-medium text-foreground' : '')}>{label}</Link>
            </span>
          ))}
        </nav>
        <form action={`${first.pathname}${first.hash}`} method="get" role="search" className="flex items-center gap-1.5">
          {kept.map(([k, v], i) => <input key={i} type="hidden" name={k} value={v} />)}
          <input
            type="search" name={findParam} defaultValue={find ?? ''} placeholder={kind === 'tokens' ? 'Find a token number' : 'Find a wallet (0x…)'}
            aria-label={kind === 'tokens' ? `Find a token ${lens.name} caught, by its number` : `Find a wallet ${lens.name} caught, by its address or the start of it`}
            className="w-44 rounded-md border bg-card px-2 py-1 text-foreground"
          />
          <button type="submit" className="rounded-md border bg-card px-2.5 py-1 font-medium hover:bg-muted">Find</button>
        </form>
      </div>
      {find !== null ? (
        <p className="mb-2 text-sm text-muted-foreground">
          {total.toLocaleString()} of {plural(of, unit)} match “{find}” · <Link href={clear} className="font-medium text-foreground hover:underline">Clear</Link>
          {readable ? null : <> · “{find}” is {kind === 'tokens' ? 'not a token number.' : 'not a wallet address or the start of one.'}</>}
        </p>
      ) : null}
      {rows.length === 0 ? (
        find === null ? <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">{empty}</p> : null
      ) : (
        <ol start={start + 1} className="rounded-lg border bg-card">
          {kind === 'tokens'
            ? (rows as TokenLine[]).map((l, i) => (
              <Row key={l.tokenId} n={start + i + 1} line={l} tone={lens.tone} why={tokenWhy(l)}
                name={<Link href={`${base}/t/${l.tokenId}`} title={`Token #${l.tokenId}`} className="font-mono font-medium text-foreground hover:underline">#{l.tokenId.length > 20 ? `${l.tokenId.slice(0, 18)}…` : l.tokenId}</Link>}
                loops={`${base}/t/${l.tokenId}?method=${method}`}
                group={tradesHref(base, { kind: 'all', group: { method, token: l.tokenId } })}
                trades={tradesHref(base, { kind: 'all', token: l.tokenId })}
                caught={tradesHref(base, { kind: 'all', caught: [method], token: l.tokenId })}
                volume={tradesHref(base, { kind: 'all', caught: [method], token: l.tokenId, sort: 'price', dir: 'desc' })}
              />
            ))
            : (rows as WalletLine[]).map((l, i) => (
              <Row key={l.address} n={start + i + 1} line={l} tone={lens.tone} why={walletWhy(l)}
                name={<Wallet chainId={chainId} address={l.address} />}
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

/** One row: its number, its name, why in words, its caught of its trades, its caught volume, and the share as a bar in the lens's hue. */
function Row({ n, line, tone, why, name, loops, group, trades, caught, volume }: {
  n: number; line: TokenLine | WalletLine; tone: keyof typeof DOT; why: WhyPart[]; name: React.ReactNode; loops: string; group: string; trades: string; caught: string; volume: string;
}) {
  const number = 'font-medium text-foreground hover:underline';
  return (
    <li className="border-b px-3 py-2 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span data-row-number className="w-7 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{n}</span>
        <span className="min-w-0 truncate">{name}</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          <Link href={caught} title="The trades it caught" className={number}>{line.caught.toLocaleString()}</Link>
          {' of '}
          <Link href={trades} title="All its counted trades" className={number}>{line.trades.toLocaleString()}</Link>
          {' trades'}
        </span>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums" title="Volume of the caught sales priced in ETH or WETH">
          {line.volumeWei === '0' ? '—' : <Link href={volume} title="The trades it caught, biggest first" className={number}>{eth(line.volumeWei)}</Link>}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-3 pl-9">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {why.map((p, i) => p.opens === undefined ? <span key={i}>{p.text}</span> : (
            <Link key={i} href={p.opens === 'loops' ? loops : group} className="text-foreground hover:underline">{p.text}</Link>
          ))}
        </p>
        <span aria-hidden className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
          <i className={cn('block h-full rounded-full', DOT[tone])} style={{ width: `${(line.caught / Math.max(1, line.trades)) * 100}%` }} />
        </span>
      </div>
    </li>
  );
}
