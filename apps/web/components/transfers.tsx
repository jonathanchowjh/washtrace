import Link from 'next/link';
import { METHODS, ZERO, type FlaggedTransfer, type Method, type Witness } from '@washtrace/detect';
import { verdictOf } from '@/lib/layout';
import { LENSES, eth, explorer, short } from '@/lib/format';
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
  return (
    <>
      <Wallet chainId={chainId} address={a} /> and <Wallet chainId={chainId} address={b} />{' '}
      {w.middle === null ? 'paid each other directly' : <>share money with <Wallet chainId={chainId} address={w.middle} /></>}{' '}
      (<a className="hover:underline" href={`${explorer(chainId)}/tx/${w.flowTx}`} target="_blank" rel="noreferrer">tx</a>)
    </>
  );
}

/** Two witnesses that would read as the same sentence share a key. */
function witnessKey(w: Witness): string {
  if (w.kind === 'pair') return `pair|${w.pair.join(',')}|${w.middle}|${w.flowTx}`;
  const base = `${[...w.wallets].sort().join(',')}|${w.cycles}`;
  return w.kind === 'scc' ? `scc|${base}` : `flow|${base}|${w.via.length}`;
}

export interface Reason { witness: Witness; methods: Method[]; rows: number[] }

/**
 * A token's flags grouped by reason, so a pattern that four transfers share
 * is said once with the four rows it covers, and the lenses that agree on it
 * are named together. Rows are 1-based, as the graph labels them.
 */
export function reasons(transfers: readonly FlaggedTransfer[]): Reason[] {
  const by = new Map<string, Reason>();
  transfers.forEach((t, i) => {
    for (const m of METHODS) {
      const w = t.flags[m];
      if (!w) continue;
      const key = witnessKey(w);
      const r = by.get(key) ?? { witness: w, methods: [], rows: [] };
      if (!r.methods.includes(m)) r.methods.push(m);
      if (!r.rows.includes(i + 1)) r.rows.push(i + 1);
      by.set(key, r);
    }
  });
  return [...by.values()];
}

/** "2–5", "2, 4, 7". */
export function rowList(rows: readonly number[]): string {
  const sorted = [...rows].sort((a, b) => a - b);
  const run = sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return run && sorted.length > 2 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ');
}

const ROW_TONE = { cycle: 'bg-cycle-surface/70', money: 'bg-money-surface/70', clean: '' } as const;

/**
 * Transfers with each lens's verdict and its reason. `numbered` keeps the
 * token page's order: the number is the arrow's label in its graph.
 */
export function Transfers({ chainId, transfers, numbered = false, collection = false }: {
  chainId: number; transfers: readonly FlaggedTransfer[]; numbered?: boolean; collection?: boolean;
}) {
  if (transfers.length === 0) return <p className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">No transfers read yet.</p>;
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
            const v = verdictOf(t);
            const first = METHODS.map((m) => t.flags[m]).find((w) => w !== undefined);
            return (
              <tr key={`${t.txHash}:${t.logIndex}`} id={numbered ? `t${i + 1}` : undefined} className={cn('border-b last:border-b-0 align-top target:outline-2 target:outline-focus', ROW_TONE[v])}>
                {numbered ? <td className="px-3 py-2 tabular-nums text-muted-foreground">{i + 1}</td> : null}
                <td className="px-3 py-2 whitespace-nowrap">
                  <a className="text-xs tabular-nums hover:underline" href={`${explorer(chainId)}/tx/${t.txHash}`} target="_blank" rel="noreferrer">
                    {t.blockTime === null ? `block ${t.blockNumber.toLocaleString()}` : <Time ms={t.blockTime * 1000} />}
                  </a>
                </td>
                {collection && t.collection ? (
                  <td className="px-3 py-2">
                    <Link className="hover:underline" href={`/c/${t.collection.chainId}/${t.collection.address}/t/${t.tokenId}`}>
                      {t.collection.name ?? short(t.collection.address)} #{t.tokenId.length > 10 ? `${t.tokenId.slice(0, 8)}…` : t.tokenId}
                    </Link>
                  </td>
                ) : null}
                <td className="px-3 py-2 whitespace-nowrap"><Wallet chainId={chainId} address={t.from} /> → <Wallet chainId={chainId} address={t.to} /></td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {t.marketplace === null ? <span className="text-muted-foreground">transfer</span> : (
                    <>{t.marketplace}<span className="ml-2 text-xs tabular-nums">{t.priceWei === null ? 'unpriced' : eth(t.priceWei, t.currency === '' ? 'ETH' : 'WETH')}</span></>
                  )}
                </td>
                <td className="px-3 py-2">
                  {METHODS.some((m) => t.flags[m]) ? (
                    <span className="flex flex-wrap gap-1">
                      {METHODS.filter((m) => t.flags[m]).map((m) => (
                        <span key={m} className={cn('rounded px-1.5 py-px text-[11px] whitespace-nowrap text-background', m === 'A' || t.flags.A ? 'bg-cycle' : 'bg-money')}>
                          {LENSES[m].name}
                        </span>
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
