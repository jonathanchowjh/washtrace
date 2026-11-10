import Link from 'next/link';
import { METHODS, ZERO, type FlaggedTransfer, type LensFlag, type Witness } from '@washtrace/detect';
import type { LensKey } from '@washtrace/detect/trades';
import { eth, lensInfo, num, plural, short, tokenLabel, type Lenses } from '@/lib/format';
import { cardSrc, explorerTx, lensTabHref, txHref, walletHref, withFrom } from '@/lib/links';
import { FILL } from './kit';
import { Empty, Ext } from '@/components/ui';
import { toneOf, SHOWN } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';
import { HoverCard } from '@/components/hover-card';

/**
 * A wallet, linked to its page: under `within`'s tabs when it is given (a
 * collection's base), so a link from inside a collection stays inside it. The
 * zero address is a mint or a burn, not a wallet.
 */
export function Wallet({ chainId, address, within, from }: { chainId: number; address: string; within?: string; from?: string }) {
  if (address === ZERO) return <span className="text-muted-foreground">mint/burn</span>;
  const link = <Link href={withFrom(walletHref(chainId, address, within), from)} title={address} className="font-mono hover:underline">{short(address)}</Link>;
  // Inside a collection there is a card to show: its trades there and its ring.
  return within ? <HoverCard src={cardSrc(within, 'wallet', address)}>{link}</HoverCard> : link;
}

/** Why one method flagged one transfer, in a sentence; its wallets link under `within`, as Wallet's do. */
export function because(w: Witness, chainId: number, within?: string): React.ReactNode {
  if (w.kind === 'scc') return `${w.wallets.length} wallets pass it round in ${plural(w.cycles, 'cycle')}`;
  if (w.kind === 'scc+flow') {
    return `${w.wallets.length} wallets in a loop closed by ${w.via.length === 1 ? 'a payment back' : `${w.via.length} money paths`}`;
  }
  const [a, b] = w.pair;
  const tx = explorerTx(chainId, w.flowTx);
  return (
    <>
      <Wallet chainId={chainId} address={a} within={within} /> and <Wallet chainId={chainId} address={b} within={within} />{' '}
      {w.middle === null ? 'paid each other directly' : <>share money with <Wallet chainId={chainId} address={w.middle} within={within} /></>}
      {tx === null ? null : <>{' '}(<Ext href={tx}>tx</Ext>)</>}
    </>
  );
}

/**
 * Why a lens of yours flagged one transfer: the way back it found, in one
 * line. The wallets counted are those past the seller and the buyer; the
 * money count leaves out a funding, which is said on its own.
 */
export function ownBecause(f: Pick<LensFlag, 'path' | 'wallets'>): string {
  const trade = f.path[0];
  const through = new Set(f.wallets.filter((w) => w !== trade?.from && w !== trade?.to)).size;
  // Other tokens are money too.
  const money = f.path.slice(1).filter((e) => e.kind === 'eth' || e.kind === 'internal' || e.kind === 'weth' || e.kind === 'other-tokens').length;
  const funder = f.path.length > 1 && f.path[f.path.length - 1]!.kind === 'funds';
  return `Back to the seller through ${through === 0 ? 'no wallet' : plural(through, 'wallet')}${money > 0 ? `, ${money} by money` : ''}${funder ? ', closed at a funder' : ''}`;
}

/** "2–5", "2, 4, 7". */
export function rowList(rows: readonly number[]): string {
  const sorted = [...rows].sort((a, b) => a - b);
  const run = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return run && sorted.length > 2 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ');
}

const ROW_TONE = { cycle: 'bg-cycle-surface/70', money: 'bg-money-surface/70', apart: 'bg-muted/60', clean: '' } as const;
// A chip wears its own lens's tone, whatever the row's: a row both Round trips and Money loops back flag has one of each.
/**
 * Transfers with each lens's verdict and its reason. `numbered` keeps the
 * token page's order: the number is the arrow's label in its graph. A page or
 * a filter shows only some of a token's rows, so `numbers` gives each shown
 * row its place in the whole chain order. A lens chip opens that lens's tab of
 * the row's collection, or of `base` when the rows carry none (one token's page).
 * `own` gives the lenses of yours that flag a row, by `txHash:logIndex`, chipped
 * after the built-ins' and named from `names`. `within` keeps wallet and
 * trade links under that collection's tabs, as Wallet's.
 */
export function Transfers({ chainId, transfers, numbered = false, numbers, collection = false, base, within, own, names = {} }: {
  chainId: number; transfers: readonly FlaggedTransfer[]; numbered?: boolean; numbers?: readonly number[]; collection?: boolean; base?: string; within?: string;
  own?: ReadonlyMap<string, readonly LensKey[]>; names?: Lenses;
}) {
  if (transfers.length === 0) return <Empty>No transfers read yet.</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[52rem] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            {numbered ? <th className="px-3 py-2 font-medium">#</th> : null}
            <th className="px-3 py-2 font-medium">When</th>
            {collection ? <th className="px-3 py-2 font-medium">Token</th> : null}
            <th className="px-3 py-2 font-medium">From → to</th>
            <th className="px-3 py-2 font-medium">Sale</th>
            <th className="px-3 py-2 font-medium">Lenses that flag it</th>
            <th className="px-3 py-2 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t, i) => {
            const tone = toneOf(t);
            const first = METHODS.map((m) => t.flags[m]).find((w) => w !== undefined);
            const n = numbers?.[i] ?? i + 1;
            const tx = explorerTx(chainId, t.txHash);
            const keys: LensKey[] = [...SHOWN.filter((m) => t.flags[m]), ...(own?.get(`${t.txHash}:${t.logIndex}`) ?? [])];
            const chipBase = t.collection ? `/c/${t.collection.chainId}/${t.collection.address}` : base;
            return (
              <tr key={`${t.txHash}:${t.logIndex}`} id={numbered ? `t${n}` : undefined} className={cn('border-b last:border-b-0 align-top target:outline-2 target:outline-focus', ROW_TONE[tone])}>
                {numbered ? <td data-row-number className="px-3 py-2 tabular-nums text-muted-foreground">{n}</td> : null}
                <td className="px-3 py-2 whitespace-nowrap">
                  <Link className="text-xs tabular-nums hover:underline" href={txHref(chainId, t.txHash, within)} title="Open this trade">
                    {t.blockTime === null ? `block ${num(t.blockNumber)}` : <Time ms={t.blockTime * 1000} />}
                  </Link>
                  {tx === null ? null : <Ext href={tx} className="ml-1 text-xs text-muted-foreground" title="Open the transaction on the block explorer">tx</Ext>}
                </td>
                {collection && t.collection ? (
                  <td className="px-3 py-2">
                    <Link className="hover:underline" href={`/c/${t.collection.chainId}/${t.collection.address}/t/${t.tokenId}`}>
                      {t.collection.name ?? short(t.collection.address)} #{tokenLabel(t.tokenId)}
                    </Link>
                  </td>
                ) : null}
                <td className="px-3 py-2 whitespace-nowrap"><Wallet chainId={chainId} address={t.from} within={within} /> → <Wallet chainId={chainId} address={t.to} within={within} /></td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {t.marketplace === null ? <span className="text-muted-foreground">transfer</span> : (
                    <>{t.marketplace}<span className="ml-2 text-xs tabular-nums">{t.priceWei === null ? 'unpriced' : <Link href={txHref(chainId, t.txHash, within)} title="Open this trade" className="hover:underline">{eth(t.priceWei, t.currency === '' ? 'ETH' : 'WETH')}</Link>}</span></>
                  )}
                </td>
                <td className="px-3 py-2">
                  {keys.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {keys.map((m) => <Chip key={m} m={m} names={names} base={chipBase} />)}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 text-xs">{first ? because(first, chainId, within) : <span className="text-muted-foreground">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A lens's name on a coloured chip in its own tone; a link to that lens's tab where the collection is known. A lens no longer saved has no chip. */
function Chip({ m, names, base }: { m: LensKey; names: Lenses; base?: string }) {
  const info = lensInfo(m, names);
  if (info === null) return null;
  const cls = cn('rounded px-1.5 py-px text-[11px] whitespace-nowrap text-background', FILL[info.tone]);
  return base === undefined ? <span className={cls}>{info.name}</span>
    : <Link href={lensTabHref(base, m, { evidence: true })} title={`Open the evidence for ${info.name}`} className={cn(cls, 'hover:underline')}>{info.name}</Link>;
}
