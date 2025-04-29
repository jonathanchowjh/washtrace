import Link from 'next/link';
import { METHODS, ZERO, type FlaggedTransfer, type Witness } from '@washtrace/detect';
import { verdictOf } from '@/lib/layout';
import { METHOD_NAMES, blockTime, eth, explorer, short } from '@/lib/format';
import { cn } from '@/lib/utils';

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

const ROW_TONE = { cycle: 'bg-cycle-surface', money: 'bg-money-surface', clean: '' } as const;

/**
 * Transfers with each method's verdict and its reason. `numbered` keeps the
 * token page's order: the number is the arrow's label in its graph.
 */
export function Transfers({ chainId, transfers, numbered = false, collection = false }: {
  chainId: number; transfers: readonly FlaggedTransfer[]; numbered?: boolean; collection?: boolean;
}) {
  if (transfers.length === 0) return <p className="rounded-md border bg-card p-4 text-muted-foreground">No transfers read yet.</p>;
  return (
    <div className="overflow-x-auto rounded-md border bg-card">
      <table className="w-full min-w-[52rem] text-left">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            {numbered ? <th className="px-3 py-2 font-medium">#</th> : null}
            <th className="px-3 py-2 font-medium">When</th>
            {collection ? <th className="px-3 py-2 font-medium">Token</th> : null}
            <th className="px-3 py-2 font-medium">From → to</th>
            <th className="px-3 py-2 font-medium">Sale</th>
            <th className="px-3 py-2 font-medium">Flagged by</th>
            <th className="px-3 py-2 font-medium">Why</th>
          </tr>
        </thead>
        <tbody>
          {transfers.map((t, i) => {
            const v = verdictOf(t);
            const first = METHODS.map((m) => t.flags[m]).find((w) => w !== undefined);
            return (
              <tr key={`${t.txHash}:${t.logIndex}`} id={numbered ? `t${i + 1}` : undefined} className={cn('border-b last:border-b-0 align-top', ROW_TONE[v])}>
                {numbered ? <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{i + 1}</td> : null}
                <td className="px-3 py-2 whitespace-nowrap">
                  <a className="font-mono text-xs hover:underline" href={`${explorer(chainId)}/tx/${t.txHash}`} target="_blank" rel="noreferrer">
                    {t.blockTime === null ? `block ${t.blockNumber.toLocaleString()}` : blockTime(t.blockTime)}
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
                    <>{t.marketplace}<span className="ml-2 font-mono text-xs">{t.priceWei === null ? 'unpriced' : eth(t.priceWei, t.currency === '' ? 'ETH' : 'WETH')}</span></>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className="flex gap-1">
                    {METHODS.map((m) => (
                      <span key={m} className={cn('rounded px-1.5 py-px font-mono text-[11px]', t.flags[m] ? (m === 'A' || t.flags.A ? 'bg-cycle text-background' : 'bg-money text-background') : 'text-muted-foreground')}>
                        {t.flags[m] ? METHOD_NAMES[m].replace('SCC ', '') : '·'}
                      </span>
                    ))}
                  </span>
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
