import Link from 'next/link';
import { ZERO, type FlaggedTransfer, type Flow, type LensFlag, type Witness } from '@washtrace/detect';
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
 * Its links carry `ctx`, as a card's payment rows do.
 */
export function because(w: Witness, chainId: number, within?: string, plain = false, ctx: Context = {}): React.ReactNode {
  const at = (address: string) => (plain ? short(address) : <Wallet chainId={chainId} address={address} within={within} ctx={ctx} />);
  if (w.kind === 'scc') return `${w.wallets.length} wallets pass it round in ${plural(w.cycles, 'cycle')}`;
  if (w.kind === 'scc+flow') {
    // One way back with its path recorded says who paid whom, and through how many; several, or a loop saved before paths were, as before.
    const [from, to] = w.via.length === 1 ? w.via[0]! : [];
    const path = w.paths?.find((p) => p.wallets[0] === from && p.wallets[p.wallets.length - 1] === to);
    if (from === undefined || to === undefined || path === undefined) return `${w.wallets.length} wallets in a loop closed by ${w.via.length === 1 ? 'a payment back' : `${w.via.length} money paths`}`;
    const through = path.wallets.length - 2;
    return <>{at(from)} paid {at(to)} back {through === 0 ? 'directly' : `through ${plural(through, 'other wallet')}`}, closing a loop of {plural(w.wallets.length, 'wallet')}</>;
  }
  const [a, b] = w.pair;
  // Inside a collection the payment opens its own view; elsewhere only the explorer shows it.
  const tx = plain || within ? null : explorerTx(chainId, w.flowTx);
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
  const pay = plain || !within ? null : <>{' '}(<Link href={carry(txHref(chainId, w.flowTx, within), ctx)} prefetch={false} className="underline">payment</Link>)</>;
  return <>{said}{pay}{tx === null ? null : <>{' '}(<Ext href={tx}>tx</Ext>)</>}</>;
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
                <td className={cn('basis-full text-xs sm:px-3 sm:py-2', first === undefined && 'max-sm:hidden')}>{first ? because(first, chainId, within, false, ctx) : <span className="text-muted-foreground">—</span>}</td>
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

/** The unit a payment is in: wrapped ETH is WETH, the rest ETH. */
export const unitOf = (f: Pick<Flow, 'kind'>): string => (f.kind === 'token' ? 'WETH' : 'ETH');

/** How each payment between two wallets moved, in words. */
export const FLOW_KIND: Readonly<Record<Flow['kind'], string>> = { native: 'direct', internal: 'inside a contract call', token: 'wrapped ETH' };

/**
 * Payments as a table, the one home of a payment's row: when, how and how
 * much. With `self`, one wallet's payments with another: which way each went
 * for it, and the payment's own transaction, which opens its view under
 * `within`'s tabs, else on the explorer. Without it, the payments of one
 * transaction: who paid whom, the wallets linked under `within`.
 * With `card`, a lens card's short list instead: a row a payment, who paid
 * whom with the role of each in `card.roles`, how much, when, and a link to
 * the payment's own view. The payment `card.named` is marked, the one the
 * lens names. In the order given, which is no order of the money's path.
 */
export function Payments({ chainId, flows, self, within, ctx = {}, card }: { chainId: number; flows: readonly Flow[]; self?: string; within?: string; ctx?: Context; card?: { roles: ReadonlyMap<string, string>; named?: string } }) {
  if (card !== undefined) {
    const who = (address: string) => <><Wallet chainId={chainId} address={address} within={within} ctx={ctx} />{card.roles.has(address) ? ` (${card.roles.get(address)})` : ''}</>;
    return (
      <ul className="grid gap-1 text-xs">
        {flows.map((f) => (
          <li key={`${f.txHash}:${f.kind}:${f.from}:${f.to}:${f.token}:${f.valueWei}`} data-payment className="min-w-0 border-l-2 border-dashed border-flow pl-2">
            {who(f.from)} → {who(f.to)} · {eth(f.valueWei, unitOf(f))} · <Time ms={f.blockTime * 1000} /> ·{' '}
            <Link href={carry(txHref(chainId, f.txHash, within), ctx)} prefetch={false} title={f.txHash} className="underline">payment {short(f.txHash)}</Link>
            {f.txHash === card.named ? <span className="text-muted-foreground"> · the one the lens names</span> : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[30rem] text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th className="px-3 py-2 font-medium">When</th>
            {self === undefined ? <><th className="px-3 py-2 font-medium">From</th><th className="px-3 py-2 font-medium">To</th></> : <th className="px-3 py-2 font-medium">Which way</th>}
            <th className="px-3 py-2 font-medium">How</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
            {self === undefined ? null : <th className="px-3 py-2 font-medium">Transaction</th>}
          </tr>
        </thead>
        <tbody>
          {flows.map((f) => {
            const explorer = explorerTx(chainId, f.txHash);
            return (
              <tr key={`${f.txHash}:${f.kind}:${f.from}:${f.to}:${f.token}:${f.valueWei}`} className="border-b last:border-b-0">
                <td className="px-3 py-1.5 whitespace-nowrap text-xs tabular-nums"><Time ms={f.blockTime * 1000} /></td>
                {self === undefined
                  ? <><td className="px-3 py-1.5"><Wallet chainId={chainId} address={f.from} within={within} ctx={ctx} /></td><td className="px-3 py-1.5"><Wallet chainId={chainId} address={f.to} within={within} ctx={ctx} /></td></>
                  : <td className="px-3 py-1.5">{f.from === self ? 'it sent' : 'it received'}</td>}
                <td className="px-3 py-1.5 text-muted-foreground">{FLOW_KIND[f.kind]}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{eth(f.valueWei, unitOf(f))}</td>
                {self === undefined ? null : (
                  <td className="px-3 py-1.5 text-xs">
                    {within ? <Link href={carry(txHref(chainId, f.txHash, within), ctx)} prefetch={false} title={f.txHash} className="font-mono underline">{short(f.txHash)}</Link>
                      : explorer === null ? <span className="font-mono">{short(f.txHash)}</span> : <Ext href={explorer} title={f.txHash}>tx</Ext>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
