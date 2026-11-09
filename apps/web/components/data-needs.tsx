'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { WALKED, depthNeeded, type LensRule } from '@washtrace/detect/lens-rule';
import { moneyReason, pendingUpTo, tokensReason } from '@washtrace/detect/lens-reads';
import type { MoneyRead, TokenCounts } from '@washtrace/detect';
import { LOCAL_ONLY } from '@/lib/auth';
import { ETHERSCAN_CTA, ETHERSCAN_HREF, about, floorTime, num, plural } from '@/lib/format';
import { BUTTON, send } from './lens-actions';

/** `asks`: the action is a button that changes this collection, not a link. */
type Line = { key: string; text: ReactNode; action?: ReactNode; asks?: boolean; error?: string | null };

const keyLink = <a href={ETHERSCAN_HREF} className="underline hover:text-foreground">{ETHERSCAN_CTA}</a>;

/**
 * The readiness strip: one line for each read this lens is short of (money,
 * other tokens, this collection's own history), each with the one action that
 * helps: a button that asks the worker, or the link to add the Etherscan key
 * the read waits on. A line with no action is a read already running, which
 * only time closes. When nothing is short the strip renders nothing.
 *
 * `rule` is the editor's unsaved rule, so the lines follow what is being typed.
 * `money` is what is read of this collection's money; `estimate` what reading
 * out to the rule's depth would add, from `estimateTo`, or null when the
 * worker has not counted that far. `fanout`, `followHops` (the global limit)
 * and `callsPerWallet` come from the server, which this client component may
 * not import. `funding` is whether an Etherscan key is set. `behind`: the
 * edited lens's run is behind the collection's version, so it has not read
 * what was fetched since; false for a lens not run yet.
 * `paused`: the collection is paused, so the worker does not walk it.
 * `tokens`: what the Other tokens line reads (tokensReason): `started` is
 * whether Read other tokens was pressed, `counts` the worker's last count of
 * that read (null before one), `payees` the worker's tokens.payees,
 * `runTokensRead` the token reads the edited lens's last run took in, and
 * `symbols` the listed tokens' symbols for this chain, which this client
 * component cannot import.
 */
export function DataNeeds({ rule, transfers, transfersRead, money, estimate, funding, perSecond, watched, writable, chainId, address, followHops, fanout, callsPerWallet, behind, paused, tokens }: {
  rule: LensRule; transfers: number;
  /** False while the collection's history is still being read (`unread` of its coverage): its transfers are not all in. */
  transfersRead: boolean; money: MoneyRead; estimate: { wallets: number; exactTo: number } | null;
  funding: boolean; perSecond: number; watched: number; writable: boolean; chainId: number; address: string;
  followHops: number; fanout: number; callsPerWallet: number; behind: boolean; paused: boolean;
  tokens: { started: boolean; counts: TokenCounts | null; payees: boolean; runTokensRead: number | null; symbols: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const needed = depthNeeded(rule);
  // The money check's edges (WALKED). Other tokens is a money edge too, but has a read of its own, so it has its own line.
  const usesMoney = WALKED.some((k) => rule.edges[k].use) && rule.hops.max !== null;
  const usesNft = rule.edges['nft-token'].use || rule.edges['nft-collection'].use;

  /** POSTs one of the worker's read requests for this collection, then refreshes so the lines follow it. */
  async function ask(path: string, body: object, fail: (e: string | null) => void) {
    fail(null);
    setBusy(true);
    const said = await send(`/api/collections/${chainId}/${address}/${path}`, 'POST', body);
    setBusy(false);
    if (said.error !== null) return fail(said.error);
    router.refresh();
  }

  const button = (label: string, title: string, onClick: () => void) => (
    <button type="button" className={BUTTON} disabled={!writable || busy} title={writable ? title : LOCAL_ONLY} onClick={onClick}>{label}</button>
  );

  /** The money line when this lens is short of money, else null. */
  function moneyLine(): Line | null {
    if (!usesMoney) return null;
    const key = 'money';
    if (!funding) return { key, text: 'Money is not read: with no Etherscan key, the lens runs on the stored money trail only', action: keyLink };
    // Wallets further out are followed from the traders' own, so they wait for the traders' check.
    if (money.traders.checked < money.traders.of) {
      return { key, text: `The traders' check is still running: ${num(money.traders.checked)} of ${num(money.traders.of)} traders checked. Wallets further out are followed after it.` };
    }
    // One decision with the share's qualifier (moneyReason): money still being read for this lens is never enough.
    const why = moneyReason(rule, money, followHops, behind);
    if (why === null) return null;
    // seedReach skips a paused collection, so the walk is not running: it goes on once resumed.
    if (why === 'seeding' && paused) return { key, text: 'Paused: finding the wallets continues once this collection is resumed' };
    if (why === 'seeding') return { key, text: `Finding the wallets up to ${money.ownLimit ?? money.limit} wallets out from the money already read` };
    if (why === 'pending') return { key, text: `Reading: ${plural(pendingUpTo(money.pendingByDepth, needed), 'wallet')} still to read up to ${needed} wallets out` };
    // Behind as written to since the latest analysis, or as run on an older one: the analysis or the lens run is to come.
    if (why === 'behind') return { key, text: 'Read: the next analysis or lens run takes it in' };
    const short = estimate === null
      ? 'Not counted yet: washtrace counts how many wallets this means in a coming money check.'
      : `needs about ${plural(estimate.wallets, 'more wallet')} checked, ${about(((estimate.wallets * callsPerWallet) / perSecond) * 1000)} at ${num(perSecond)} Etherscan calls a second`;
    return {
      key, error, asks: true,
      text: `Money is read ${money.limit} wallets out, and this lens needs ${needed}: ${short}`,
      action: button(`Read money ${needed} wallets out`,
        `The worker follows this collection's money out to ${needed} wallets out; this lens's share reads "so far" while it does`,
        () => void ask('follow', { hops: needed }, setError)),
    };
  }

  /** The Other tokens line when this lens is short of those reads, else null: tokensReason in words. */
  function tokensLine(): Line | null {
    if (!rule.edges['other-tokens'].use) return null;
    const key = 'tokens';
    if (!funding) return { key, text: 'Other tokens are not read: with no Etherscan key, they cannot be asked for', action: keyLink };
    const why = tokensReason(rule, tokens.started, tokens.counts, tokens.runTokensRead);
    if (why === null || why === 'unreached') return null;
    const c = tokens.counts;
    if (why === 'off') {
      const within = money.estimate?.within;
      // The estimate counts how many wallets this means, with one call each; token reads share each pass with the money check, so the time is a floor.
      const payees = tokens.payees ? `; plus up to ${fanout} for each trader paid in these tokens` : '';
      const reads = tokens.symbols === '' ? 'none are listed for this chain' : tokens.symbols;
      return {
        key, error: tokenError, asks: true,
        text: `Other tokens (${reads}) are not read: ${typeof within === 'number'
          ? `about ${plural(within, 'wallet')}, at least ${floorTime((within / perSecond) * 1000)} at ${num(perSecond)} Etherscan calls a second${payees}`
          : 'not counted yet, washtrace counts how many wallets this means in a coming money check'}`,
        action: button('Read other tokens',
          `The worker reads the listed tokens of this collection's wallets; a lens using Other tokens reads "so far" while it does`,
          () => void ask('tokens', {}, setTokenError)),
      };
    }
    // seedReach and the token lanes skip a paused collection: it goes on once resumed.
    if ((why === 'seeding' || why === 'pending') && paused) return { key, text: 'Other tokens: paused, reading continues once this collection is resumed' };
    if (c === null) return { key, text: 'Other tokens: reading, the next money check counts the wallets' };
    if (why === 'seeding') {
      const moneyFailed = c.moneyFailed > 0 ? `; ${num(c.moneyFailed)} ${c.moneyFailed === 1 ? "wallet's money check" : "wallets' money checks"} failed, tried again hourly` : '';
      return { key, text: `Other tokens: ${num(c.read)} of ${num(c.wallets)} wallets read so far, finding this collection's wallets up to ${Math.max(followHops, money.ownLimit ?? 0)} wallets out${moneyFailed}` };
    }
    if (why === 'pending') {
      const failed = c.failed > 0 ? `; ${num(c.failed)} failed, tried again hourly` : '';
      return { key, text: `Other tokens: reading, ${plural(c.wallets - c.read, 'wallet')} still to read${failed}` };
    }
    return { key, text: 'Other tokens: read, the next lens run takes it in' };
  }

  const collection: Line | null = usesNft && !transfersRead
    ? { key: 'collection', text: `This collection's transfers are still being read: ${num(transfers)} so far` }
    : null;
  const lines = [moneyLine(), tokensLine(), collection].filter((l): l is Line => l !== null);
  if (lines.length === 0) return null;
  const buttons = lines.some((l) => l.asks);
  const reading = lines.some((l) => l.key !== 'collection');

  return (
    <section aria-labelledby="data-needs" className="text-sm">
      <h3 id="data-needs" className="mb-1 font-medium">Data this lens needs</h3>
      <ul className="space-y-1.5">
        {lines.map((l) => (
          <li key={l.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span>{l.text}</span>
            {l.action}
            {l.error ? <span role="alert" className="basis-full text-xs text-fault">{l.error}</span> : null}
          </li>
        ))}
      </ul>
      {buttons ? <p className="mt-1 text-xs text-muted-foreground">Applies to this collection for every lens; Cancel does not undo it.</p> : null}
      {reading ? <p className="mt-1 text-xs text-muted-foreground">washtrace does not follow past a wallet that sent to more than {fanout} others, or whose history or token list was too long to read.</p> : null}
      <p className="mt-1 text-xs text-muted-foreground">
        {plural(watched, 'collection')} watched · <a href="/" className="underline hover:text-foreground" title="Watching a collection is what lets a lens read its transfers">Watch another collection</a>
      </p>
    </section>
  );
}
