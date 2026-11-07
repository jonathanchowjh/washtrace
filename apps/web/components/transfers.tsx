import Link from 'next/link';
import { METHODS, ZERO, type FlaggedTransfer, type Method, type Witness } from '@washtrace/detect';
import { LENSES, eth, num, short, tokenLabel } from '@/lib/format';
import { explorerTx } from '@/lib/links';
import { Empty, Ext } from '@/components/head';
import { toneOf } from '@/lib/metrics';
import { cn } from '@/lib/utils';
import { Time } from '@/components/time';

/** A wallet, linked to its page; the zero address is a mint or a burn, not a wallet. */
export function Wallet({ chainId, address }: { chainId: number; address: string }) {
  if (address === ZERO) return <span className="text-muted-foreground">mint/burn</span>;
  return <Link href={`/w/${chainId}/${address}`} title={address} className="font-mono hover:underline">{short(address)}</Link>;
}

/** Why one method flagged one transfer, in a sentence. */
export function because(w: Witness, chainId: number): React.ReactNode {
  if (w.kind === 'scc') return `${w.wallets.length} wallets pass it around in ${w.cycles} cycles`;
  if (w.kind === 'scc+flow') {
    return `${w.wallets.length} wallets in a cycle closed by ${w.via.length === 1 ? 'a payment back' : `${w.via.length} money paths`}`;
  }
  const [a, b] = w.pair;
  const tx = explorerTx(chainId, w.flowTx);
  return (
    <>
      <Wallet chainId={chainId} address={a} /> and <Wallet chainId={chainId} address={b} />{' '}
      {w.middle === null ? 'paid each other directly' : <>share money with <Wallet chainId={chainId} address={w.middle} /></>}
      {tx === null ? null : <>{' '}(<Ext href={tx}>tx</Ext>)</>}
    </>
  );
}

/** "2–5", "2, 4, 7". */
export function rowList(rows: readonly number[]): string {
  const sorted = [...rows].sort((a, b) => a - b);
  const run = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return run && sorted.length > 2 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ');
}

const ROW_TONE = { cycle: 'bg-cycle-surface/70', money: 'bg-money-surface/70', apart: 'bg-muted/60', clean: '' } as const;
// A chip wears its own lens's tone, whatever the row's: a row both Round trips and Money loops back flag has one of each.
const CHIP = { cycle: 'bg-cycle', money: 'bg-money', apart: 'bg-muted-foreground' } as const;

/**
 * Transfers with each lens's verdict and its reason. `numbered` keeps the
 * token page's order: the number is the arrow's label in its graph. A page or
 * a filter shows only some of a token's rows, so `numbers` gives each shown
 * row its place in the whole chain order. A lens chip opens that lens's tab of
 * the row's collection, or of `base` when the rows carry none (one token's page).
 */
export function Transfers({ chainId, transfers, numbered = false, numbers, collection = false, base }: {
  chainId: number; transfers: readonly FlaggedTransfer[]; numbered?: boolean; numbers?: readonly number[]; collection?: boolean; base?: string;
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
            return (
              <tr key={`${t.txHash}:${t.logIndex}`} id={numbered ? `t${n}` : undefined} className={cn('border-b last:border-b-0 align-top target:outline-2 target:outline-focus', ROW_TONE[tone])}>
                {numbered ? <td data-row-number className="px-3 py-2 tabular-nums text-muted-foreground">{n}</td> : null}
                <td className="px-3 py-2 whitespace-nowrap">
                  <Link className="text-xs tabular-nums hover:underline" href={`/tx/${chainId}/${t.txHash}`} title="Open this trade">
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
                <td className="px-3 py-2 whitespace-nowrap"><Wallet chainId={chainId} address={t.from} /> → <Wallet chainId={chainId} address={t.to} /></td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {t.marketplace === null ? <span className="text-muted-foreground">transfer</span> : (
                    <>{t.marketplace}<span className="ml-2 text-xs tabular-nums">{t.priceWei === null ? 'unpriced' : <Link href={`/tx/${chainId}/${t.txHash}`} title="Open this trade" className="hover:underline">{eth(t.priceWei, t.currency === '' ? 'ETH' : 'WETH')}</Link>}</span></>
                  )}
                </td>
                <td className="px-3 py-2">
                  {METHODS.some((m) => t.flags[m]) ? (
                    <span className="flex flex-wrap gap-1">
                      {METHODS.filter((m) => t.flags[m]).map((m) => (
                        <Chip key={m} m={m} base={t.collection ? `/c/${t.collection.chainId}/${t.collection.address}` : base} />
                      ))}
                    </span>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 text-xs">{first ? because(first, chainId) : <span className="text-muted-foreground">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A lens's name on a coloured chip in its own tone; a link to that lens's tab where the collection is known. */
function Chip({ m, base }: { m: Method; base?: string }) {
  const cls = cn('rounded px-1.5 py-px text-[11px] whitespace-nowrap text-background', CHIP[LENSES[m].tone]);
  return base === undefined ? <span className={cls}>{LENSES[m].name}</span>
    : <Link href={`${base}?method=${m}#evidence`} title={`Open the evidence for ${LENSES[m].name}`} className={cn(cls, 'hover:underline')}>{LENSES[m].name}</Link>;
}
