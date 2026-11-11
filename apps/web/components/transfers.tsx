import Link from 'next/link';
import { ZERO, type FlaggedTransfer, type LensFlag, type Witness } from '@washtrace/detect';
import { venueName, type LensKey } from '@washtrace/detect/trades';
import { SHOWN, eth, lensInfo, num, plural, short, tokenLabel, type Lenses } from '@/lib/format';
import { cardSrc, explorerTx, lensTabHref, txHref, walletHref, carry, type Context } from '@/lib/links';
import { INLINE_ICON, KindIcon, TierMark } from './kit';
import { Empty, Ext } from '@/components/ui';
import { toneOf } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { Time } from '@/components/zone';
import { HoverCard } from '@/components/hover-card';

/**
 * A wallet, linked to its page behind its symbol: under `within`'s tabs when it is given (a
 * collection's base), so a link from inside a collection stays inside it. The
 * zero address is a mint or a burn, not a wallet. It sits in rows of many, so
 * it does not prefetch: each prefetch renders a wallet page.
 */
export function Wallet({ chainId, address, within, ctx = {} }: { chainId: number; address: string; within?: string; ctx?: Context }) {
  if (address === ZERO) return <span className="text-muted-foreground">mint/burn</span>;
  const link = <Link href={carry(walletHref(chainId, address, within), ctx)} prefetch={false} title={address} className="inline-flex items-center gap-1.5 font-mono hover:underline"><KindIcon kind="wallet" className={INLINE_ICON} />{short(address)}</Link>;
  // Inside a collection there is a card to show: its trades there and its ring.
  return within ? <HoverCard src={cardSrc(within, 'wallet', address)}>{link}</HoverCard> : link;
}

/**
 * A token, linked to its page behind its symbol, with its hover card: `#7`, or
 * `Demo Apes #7` given a `name`. `method` opens the page with that lens's loops
 * lit and `hash` lands on a section of it. `cardClassName` shapes the card's
 * box where the link must fill its row.
 */
export function TokenLink({ base, tokenId, name, from, method, hash = '', title, className, cardClassName }: {
  base: string; tokenId: string; name?: string; from?: string; method?: string; hash?: string; title?: string; className?: string; cardClassName?: string;
}) {
  const href = carry(`${base}/t/${tokenId}${hash}`, { method, from });
  return (
    <HoverCard className={cardClassName} src={cardSrc(base, 'token', tokenId)}>
      <Link href={href} prefetch={false} title={title} className={cn('inline-flex items-center gap-1.5 hover:underline', className)}>
        <KindIcon kind="token" className={INLINE_ICON} />{name === undefined ? '' : `${name} `}#{tokenLabel(tokenId)}
      </Link>
    </HoverCard>
  );
}

/**
 * Why one method flagged one transfer, in a sentence; its wallets link under `within`, as Wallet's do.
 * `plain` is the sentence with no link in it (short addresses as text, no tx link), for a row that is itself one.
 */
export function because(w: Witness, chainId: number, within?: string, plain = false): React.ReactNode {
  if (w.kind === 'scc') return `${w.wallets.length} wallets pass it round in ${plural(w.cycles, 'cycle')}`;
  if (w.kind === 'scc+flow') {
    return `${w.wallets.length} wallets in a loop closed by ${w.via.length === 1 ? 'a payment back' : `${w.via.length} money paths`}`;
  }
  const [a, b] = w.pair;
  const tx = plain ? null : explorerTx(chainId, w.flowTx);
  const at = (address: string) => (plain ? short(address) : <Wallet chainId={chainId} address={address} within={within} />);
  // The pair is the seller and the buyer, in that order; the shape says who paid whom. A pair stored without one says only that they share money.
  const m = w.middle === null ? null : at(w.middle);
  const said = w.shape === undefined ? (m === null ? <>{at(a)} and {at(b)} paid each other directly</> : <>{at(a)} and {at(b)} share money with {m}</>)
    : w.shape === 'funder' ? <>{at(a)} and {at(b)} were both funded by {m}</>
    : w.shape === 'payee' ? <>{at(a)} and {at(b)} both paid {m}</>
    : w.shape === 'back' ? <>{at(b)} paid {at(a)} back through {m}</>
    : w.shape === 'forward' ? <>{at(a)} paid {at(b)} through {m}</>
    : w.shape === 'direct-back' ? <>{at(b)} paid {at(a)} directly</>
    : w.shape === 'direct-forward' ? <>{at(a)} paid {at(b)} directly</>
    : <>{at(a)} and {at(b)} paid each other directly</>;
  return <>{said}{tx === null ? null : <>{' '}(<Ext href={tx}>tx</Ext>)</>}</>;
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

const ROW_TONE ={ cycle: 'bg-cycle-surface/70', ceiling: 'bg-ceiling-surface/70', apart: 'bg-muted/60', clean: '' } as const;
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
 *
 * Below `sm` the table is too wide for the screen, so each row is laid out as
 * a card there: the same row, not a second copy as the Trades cards are,
 * because the graph's numbers link to a row by its id, and an id names one
 * element. A card leaves out a cell with nothing to say: it has no column to
 * hold a dash.
 */
export function Transfers({ chainId, transfers, numbered = false, numbers, collection = false, base, within, ctx = {}, own, names = {} }: {
  chainId: number; transfers: readonly FlaggedTransfer[]; numbered?: boolean; numbers?: readonly number[]; collection?: boolean; base?: string; within?: string;
  /** What its links to wallets and trades carry on: the lens the page was opened under. */
  ctx?: Context;
  own?: ReadonlyMap<string, readonly LensKey[]>; names?: Lenses;
}) {
  if (transfers.length === 0) return <Empty>No transfers read yet.</Empty>;
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="block w-full text-left text-sm sm:table sm:min-w-[52rem]">
        <thead className="hidden text-xs text-muted-foreground sm:table-header-group">
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
        <tbody className="block sm:table-row-group">
          {transfers.map((t, i) => {
            const tone = toneOf(t);
            // The reason said is the strongest lens's: a counted one's before the one never counted.
            const first = SHOWN.map((m) => t.flags[m]).find((w) => w !== undefined);
            const n = numbers?.[i] ?? i + 1;
            const tx = explorerTx(chainId, t.txHash);
            const keys: LensKey[] = [...SHOWN.filter((m) => t.flags[m]), ...(own?.get(`${t.txHash}:${t.logIndex}`) ?? [])];
            const chipBase = t.collection ? `/c/${t.collection.chainId}/${t.collection.address}` : base;
            return (
              <tr key={`${t.txHash}:${t.logIndex}`} id={numbered ? `t${n}` : undefined}
                className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-3 py-2 align-top last:border-b-0 target:outline-2 target:outline-focus sm:table-row sm:p-0', ROW_TONE[tone])}>
                {/* The card's # is drawn, not written: the cell's text stays the row's number, the graph's label for it. */}
                {numbered ? <td data-row-number className="tabular-nums text-muted-foreground before:content-['#'] sm:px-3 sm:py-2 sm:before:content-none">{n}</td> : null}
                <td className="whitespace-nowrap sm:px-3 sm:py-2">
                  <Link className="text-xs tabular-nums hover:underline" href={carry(txHref(chainId, t.txHash, within), ctx)} prefetch={false} title="Open this trade">
                    {t.blockTime === null ? `block ${num(t.blockNumber)}` : <Time ms={t.blockTime * 1000} />}
                  </Link>
                  {tx === null ? null : <Ext href={tx} className="ml-1 text-xs text-muted-foreground" title="Open the transaction on the block explorer">tx</Ext>}
                </td>
                {collection && t.collection ? (
                  <td className="basis-full font-medium sm:px-3 sm:py-2 sm:font-normal">
                    <TokenLink base={`/c/${t.collection.chainId}/${t.collection.address}`} tokenId={t.tokenId} name={t.collection.name ?? short(t.collection.address)} method={ctx.method} />
                  </td>
                ) : null}
                <td className="whitespace-nowrap sm:px-3 sm:py-2">
                  {t.from === ZERO ? <>minted to <Wallet chainId={chainId} address={t.to} within={within} ctx={ctx} /></>
                    : t.to === ZERO ? <><Wallet chainId={chainId} address={t.from} within={within} ctx={ctx} /> burned</>
                    : <><Wallet chainId={chainId} address={t.from} within={within} ctx={ctx} /> → <Wallet chainId={chainId} address={t.to} within={within} ctx={ctx} /></>}
                </td>
                <td className="whitespace-nowrap sm:px-3 sm:py-2">
                  {t.marketplace === null ? <span className="text-muted-foreground">transfer</span> : (
                    <>{venueName(t.marketplace)}<span className="ml-2 text-xs tabular-nums">{t.priceWei === null ? 'unpriced' : <Link href={carry(txHref(chainId, t.txHash, within), ctx)} prefetch={false} title="Open this trade" className="hover:underline">{eth(t.priceWei, t.currency === '' ? 'ETH' : 'WETH')}</Link>}</span></>
                  )}
                </td>
                <td className={cn('basis-full sm:px-3 sm:py-2', keys.length === 0 && 'max-sm:hidden')}>
                  {keys.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {keys.map((m) => <Chip key={m} m={m} names={names} base={chipBase} />)}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className={cn('basis-full text-xs sm:px-3 sm:py-2', first === undefined && 'max-sm:hidden')}>{first ? because(first, chainId, within) : <span className="text-muted-foreground">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A lens's name on a chip with its tier's mark, as a lens is tagged on every
 * other page; a link to that lens's tab where the collection is known. A lens
 * no longer saved has no chip.
 */
function Chip({ m, names, base }: { m: LensKey; names: Lenses; base?: string }) {
  const info = lensInfo(m, names);
  if (info === null) return null;
  const body = <><TierMark tone={info.tone} />{info.name}</>;
  return base === undefined ? <span className="chip whitespace-nowrap">{body}</span>
    : <Link href={lensTabHref(base, m, { evidence: true })} prefetch={false} title={`Open the evidence for ${info.name}`} className="chip whitespace-nowrap hover:bg-muted">{body}</Link>;
}
