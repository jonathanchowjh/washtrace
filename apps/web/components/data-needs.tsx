'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { depthNeeded, moneyReason, pendingUpTo, readThrough, type LensRule } from '@washtrace/detect/lens-rule';
import type { MoneyRead } from '@washtrace/detect';
import { LOCAL_ONLY } from '@/lib/auth';
import { eta, num, plural } from '@/lib/format';
import { send } from './lens-actions';

const BUTTON = 'rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60';

/** The most hops follow.hops allows (the Settings bound, env.ts hops()): a lens that needs more cannot be fetched. The follow route keeps the same number. */
const MOST_HOPS = 10;

/** The money edge types whose payments the money check reads. Other tokens is a money edge too, but never read yet, so it has its own row. */
const MONEY_EDGES = ['eth', 'internal', 'weth'] as const;

/** A share floored to a whole percent, so 99.96% reads 99% and never 100% while the check is still running (pct would round it up). */
const floorPct = (part: number, whole: number) => `${whole === 0 ? 0 : Math.floor((part / whole) * 100)}%`;

const hops = (n: number) => `${n} ${n === 1 ? 'hop' : 'hops'}`;

/**
 * "Data this lens needs": one row per kind of data a lens reads, what has been
 * read of it, and whether that is enough for this rule. It is how a lens that
 * reaches further than the money read learns it, and how the reader asks the
 * worker for the rest (Fetch them), for this collection only.
 *
 * `rule` is the editor's unsaved rule, so the rows follow what is being typed.
 * `money` is what is read of this collection's money; `estimate` what reading
 * out to the rule's depth would add, from `estimateTo`, or null when the
 * worker has not counted that far. `fanout`, `followHops` (the global limit)
 * and `callsPerWallet` come from the server, which this client component may
 * not import. `funding` is whether an Etherscan key is set. `behind`: the
 * edited lens's run is behind the collection's version, so it has not read
 * what was fetched since (Ruling S36); false for a lens not run yet.
 * `paused`: the collection is paused, so the worker does not walk it.
 */
export function DataNeeds({ rule, transfers, transfersRead, money, estimate, funding, perSecond, watched, writable, chainId, address, followHops, fanout, callsPerWallet, behind, paused }: {
  rule: LensRule; transfers: number;
  /** False while the collection's history is still being read (`unread` of its coverage): its transfers are not all in. */
  transfersRead: boolean; money: MoneyRead; estimate: { wallets: number; exactTo: number } | null;
  funding: boolean; perSecond: number; watched: number; writable: boolean; chainId: number; address: string;
  followHops: number; fanout: number; callsPerWallet: number; behind: boolean; paused: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needed = depthNeeded(rule);
  const used = MONEY_EDGES.filter((k) => rule.edges[k].use);
  // With no hop limit only the token's own hops are read: no money (depthNeeded).
  const usesMoney = used.length > 0 && rule.hops.max !== null;
  const usesNft = rule.edges['nft-token'].use || rule.edges['nft-collection'].use;

  async function fetchThem() {
    setError(null);
    setBusy(true);
    const said = await send(`/api/collections/${chainId}/${address}/follow`, 'POST', { hops: needed });
    setBusy(false);
    if (said.error !== null) return setError(said.error);
    router.refresh();
  }

  const fetchButton = (
    <button type="button" className={BUTTON} disabled={!writable || busy}
      title={writable ? `Follow this collection's money out to ${hops(needed)}: the worker reads those wallets, and this lens's share reads "at least" until it has` : LOCAL_ONLY}
      onClick={() => void fetchThem()}>Fetch them</button>
  );

  /** What the money row says for this lens, and the button when reading more would help. */
  function forMoney(): { text: ReactNode; button?: boolean } {
    if (!usesMoney) return { text: 'Not used by this lens' };
    if (!funding) return { text: <a href="/settings#etherscan.key" className="underline hover:text-foreground" title="The money check needs a key to read who paid whom">Needs an Etherscan key → Settings</a> };
    // Wallets further out are followed from the traders' own, so they wait for the traders' check.
    if (money.traders.checked < money.traders.of) {
      return { text: `The traders' check is still running: ${num(money.traders.checked)} of ${num(money.traders.of)} traders checked. Wallets further out are followed after it.` };
    }
    if (needed > MOST_HOPS) return { text: `Needs more than washtrace follows (${MOST_HOPS} hops)` };
    // One decision with the share's "at least" (moneyReason): money still being read for this lens is never "Enough" (Rulings S25, S31).
    const why = moneyReason(rule, money, followHops, behind);
    // seedReach skips a paused collection, so the walk is not running: it goes on once resumed.
    if (why === 'seeding' && paused) return { text: 'Paused: finding the wallets continues once this collection is resumed' };
    if (why === 'seeding') return { text: `Finding the wallets up to ${hops(money.ownLimit ?? money.limit)} out from the money already read` };
    if (why === 'pending') return { text: `Reading: ${plural(pendingUpTo(money.pendingByDepth, needed), 'wallet')} still to read up to ${hops(needed)}` };
    // Behind as written to since the latest analysis, or as run on an older one: the analysis or the lens run is to come (Ruling S41).
    if (why === 'behind') return { text: 'Read: the next analysis or lens run takes it in' };
    const k = rule.hops.max!;
    if (why === null) {
      // Money followed against its direction is not walked back, so a loop that way can be missed (Ruling S19).
      return used.some((e) => rule.edges[e].direction === 'either')
        ? { text: <>Enough the way money was sent: the loop is at most {hops(k)}<span className="block text-xs text-muted-foreground">money is followed only the way it was sent, so a loop against it can be missed</span></> }
        : { text: `Enough: the loop is at most ${hops(k)}` };
    }
    const short = estimate === null
      ? 'Not counted yet: washtrace counts how many wallets this means in a coming money check.'
      : `Needs about ${plural(estimate.wallets, 'more wallet')} checked, ${eta(((estimate.wallets * callsPerWallet) / perSecond) * 1000).replace(/ left$/, '')} at ${num(perSecond)} Etherscan calls a second`;
    return {
      text: <>
        {`Not enough: the loop is at most ${hops(k)}, and money is read ${hops(money.limit)} out`}
        <span className="block text-xs text-muted-foreground">{short}</span>
        <span className="block text-xs text-muted-foreground">Fetch them queues the reads in the worker; the run uses what is read and marks its share &quot;at least&quot;.</span>
      </>,
      button: needed <= MOST_HOPS,
    };
  }

  const verdict = forMoney();
  // The depth read through, never the limit just raised and not read yet (Ruling S37).
  const readSoFar = !funding || !usesMoney
    ? 'What is already stored'
    : `Wallets up to ${hops(readThrough(money, followHops))} out: ${floorPct(money.traders.checked, money.traders.of)} of ${num(money.traders.of)}`;

  return (
    <section aria-labelledby="data-needs" className="overflow-x-auto text-sm">
      <h3 id="data-needs" className="mb-1 font-medium">3 · Data this lens needs</h3>
      <span className="mb-1 block text-xs text-muted-foreground">how new data gets fetched</span>
      <table className="w-full min-w-[34rem] text-left">
        <caption className="mb-1 text-left text-xs text-muted-foreground">What this lens reads, against what washtrace has read, so a share is never shown as complete while its data is partly read</caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">Edge type</th>
            <th scope="col" className="py-1 pr-3 font-medium">Read so far</th>
            <th scope="col" className="py-1 pr-3 font-medium">For this lens</th>
            <th scope="col" className="py-1 font-medium"><span className="sr-only">Action</span></th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t align-top">
            <td className="py-1.5 pr-3">NFT, this collection</td>
            <td className="py-1.5 pr-3">{transfersRead ? 'All' : 'So far'} {num(transfers)} transfers</td>
            <td className="py-1.5 pr-3">{!usesNft ? 'Not used by this lens' : transfersRead ? 'Enough' : "Reading history: this collection's transfers are still being read"}</td>
            <td />
          </tr>
          <tr className="border-t align-top">
            <td className="py-1.5 pr-3">ETH, internal ETH, WETH</td>
            <td className="py-1.5 pr-3">{readSoFar}</td>
            <td className="py-1.5 pr-3">
              {verdict.text}
              <span className="mt-1 block text-xs text-muted-foreground">washtrace does not follow past a wallet that sent to more than {fanout} others, or whose history was too long to read.</span>
              {error ? <span role="alert" className="mt-1 block text-xs text-fault">{error}</span> : null}
            </td>
            <td className="py-1.5">{verdict.button ? fetchButton : null}</td>
          </tr>
          <tr className="border-t align-top text-muted-foreground">
            <td className="py-1.5 pr-3">NFT, other watched collections</td>
            <td className="py-1.5 pr-3">{plural(watched, 'collection')} watched</td>
            <td className="py-1.5 pr-3">Off in this lens</td>
            <td className="py-1.5"><a href="/" className="underline hover:text-foreground" title="Watching a collection is what lets a lens read its transfers">Watch another collection</a></td>
          </tr>
          <tr className="border-t align-top text-muted-foreground">
            <td className="py-1.5 pr-3">Other tokens</td>
            <td className="py-1.5 pr-3">Not read: washtrace has never fetched them</td>
            <td className="py-1.5 pr-3">Off in this lens</td>
            <td />
          </tr>
        </tbody>
      </table>
      {funding ? null : <p className="mt-1 text-xs text-muted-foreground">With no Etherscan key, the lens runs on the stored money trail only.</p>}
    </section>
  );
}
