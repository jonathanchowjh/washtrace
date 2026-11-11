import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { moneyFor, type Flow, type PaymentUsedBy } from '@washtrace/detect';
import { ConnectedRail, OpenUnder, ParentLine, type Home } from '@/components/connected-rail';
import { RingLink } from '@/components/rings';
import { LensName } from '@/components/methods';
import { FLOW_KIND, Payments, Wallet, because, unitOf } from '@/components/transfers';
import { Answer, Ext, Head, Section } from '@/components/ui';
import { Time } from '@/components/zone';
import { chainName } from '@/lib/chains';
import { collectionOf, transactionOf } from '@/lib/collection-reads';
import { LENSES, SHOWN, andList, eth, num, plural, short, tokenLabel } from '@/lib/format';
import { carry, explorerTx, lensTabHref, txHref, type Context } from '@/lib/links';
import { store } from '@/lib/store';

type Used = PaymentUsedBy;

/** The most lines of "used by" one payment view writes; a payment in more says how many it leaves. */
const LINES = 8;

/** The three built-in lenses, in the console's order: what a payment no lens uses is said of. */
const BUILT_INS = andList(SHOWN.map((m) => LENSES[m].name));

/** What an analysis saved before witnesses were (its `loops` null) lets a payment view say: it stored no use of any payment. */
const PREDATES = 'predates this view; the next analysis will say which lenses use it.';

/** What the payment is, in one line: one transfer's amount and ends, else how many there were. */
function titleOf(flows: readonly Flow[]): string {
  const one = flows.length === 1 ? flows[0]! : null;
  return one !== null ? `${eth(one.valueWei, unitOf(one))} from ${short(one.from)} to ${short(one.to)}`
    : `A payment of ${flows.length} transfers between ${new Set(flows.flatMap((f) => [f.from, f.to])).size} wallets`;
}

/** The payment's own facts: for one transfer, who paid whom, how much and when; for several, the table of them. */
function Facts({ chainId, flows, within, ctx }: { chainId: number; flows: readonly Flow[]; within?: string; ctx?: Context }) {
  const one = flows.length === 1 ? flows[0]! : null;
  if (one === null) return <div className="mt-2"><Payments chainId={chainId} flows={flows} within={within} ctx={ctx} /></div>;
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-muted-foreground">From</dt><dd><Wallet chainId={chainId} address={one.from} within={within} ctx={ctx} /></dd>
      <dt className="text-muted-foreground">To</dt><dd><Wallet chainId={chainId} address={one.to} within={within} ctx={ctx} /></dd>
      <dt className="text-muted-foreground">Amount</dt><dd>{eth(one.valueWei, unitOf(one))}</dd>
      <dt className="text-muted-foreground">How</dt><dd>{FLOW_KIND[one.kind]}</dd>
      <dt className="text-muted-foreground">Block</dt><dd className="tabular-nums">{num(one.blockNumber)}</dd>
      <dt className="text-muted-foreground">When</dt><dd><Time ms={one.blockTime * 1000} /></dd>
    </dl>
  );
}

/** What shows while the lenses that use a payment are still being looked for. */
function Looking() {
  return <p className="mt-6 text-sm text-muted-foreground">Looking for the lenses that use it…</p>;
}

/**
 * A payment opened from a collection's tabs: what it is, at once, and below
 * it, as it is found, which lens of the collection uses it as evidence, and
 * to flag which sales (PaymentUses). `flows` are the store's rows of it. The
 * lines never put a payment in time order, which the stored witnesses do not.
 */
export async function PaymentView({ chainId, tx, address, flows, ctx }: { chainId: number; tx: string; address: string; flows: Flow[]; ctx: Context }) {
  const c = await collectionOf(chainId, address);
  if (!c) notFound();
  const base = `/c/${chainId}/${address}`;
  const moved = new Map((await transactionOf(chainId, tx)).flatMap((t) => (t.collection ? [[t.collection.address, t.collection] as const] : [])));
  const elsewhere: Home[] = [...moved.values()].map((o) => {
    const b = `/c/${o.chainId}/${o.address}`;
    return { base: b, name: o.name ?? short(o.address), href: txHref(chainId, tx, b) };
  });
  return (
    <>
      {/* Under the tabs the layout draws the parent line. */}
      <Head
        kind="transaction"
        title={<span className="font-mono">{short(tx)}</span>}
        sub={<>Payment on {chainName(chainId)} · <Ext href={explorerTx(chainId, tx)} className="font-mono">{tx}</Ext></>}
      >
        {/* A hash that is another collection's sale: the way to that sale. */}
        <OpenUnder homes={elsewhere} />
      </Head>
      <Answer tone="clean" title={titleOf(flows)}>
        <Facts chainId={chainId} flows={flows} within={base} ctx={ctx} />
      </Answer>
      <Suspense fallback={<Looking />}>
        <PaymentUses chainId={chainId} address={address} flows={flows} ctx={ctx} />
      </Suspense>
    </>
  );
}

/** The lenses of one collection that use a payment, read after the payment is shown, with the wallets it connects. */
export async function PaymentUses({ chainId, address, flows, ctx }: { chainId: number; address: string; flows: Flow[]; ctx: Context }) {
  const c = (await collectionOf(chainId, address))!;
  const base = `/c/${chainId}/${address}`;
  const name = c.name ?? short(address);
  const used = (await store().paymentUsedBy(chainId, flows, c.id)).sort((x, y) => SHOWN.indexOf(x.use.method) - SHOWN.indexOf(y.use.method));
  const anchors = [...new Set(used.flatMap((u) => u.ring ?? []))];
  const rings = anchors.length === 0 ? [] : await store().ringLines(c.id, anchors, { money: moneyFor(chainId) });
  // The wallets of the payment and of the pairs that use it, each with what it is here.
  const roles = new Map<string, string[]>();
  const role = (a: string, r: string) => roles.set(a, [...new Set([...(roles.get(a) ?? []), r])]);
  for (const f of flows) { role(f.from, 'paid'); role(f.to, 'was paid'); }
  for (const u of used) if (u.witness.kind === 'pair') { role(u.witness.pair[0], 'seller'); role(u.witness.pair[1], 'buyer'); }
  return (
    <>
      <Suspense fallback={null}>
        <ConnectedRail chainId={chainId} address={address} ctx={ctx} wallets={[...roles].map(([a, r]) => ({ address: a, role: r.join(' · ') }))} />
      </Suspense>
      <Section title="What it is evidence of">
        {used.length === 0 ? (
          <p className="text-sm">
            {c.latest === null ? `${name} has not been analyzed yet.`
              : c.latest.loops === null ? `The latest analysis ${PREDATES}`
              : <>{BUILT_INS} don’t use this payment in {name}’s latest analysis (<Time ms={c.latest.ranAt} />).</>} washtrace read it as money.
          </p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {used.slice(0, LINES).map((u) => (
              <li key={`${u.use.method}:${u.sales[0]?.txHash}`}>
                <UsedLine u={u} flows={flows} chainId={chainId} base={base} ctx={ctx} ring={rings.find((r) => r.anchor === u.ring)} />
              </li>
            ))}
            {used.length > LINES ? <li className="text-muted-foreground">and {used.length - LINES} more</li> : null}
          </ul>
        )}
      </Section>
    </>
  );
}

/** One witness's use of the payment, as a sentence: the lens, the sales it flagged by the payment, and how the payment figures in the pattern. */
function UsedLine({ u, flows, chainId, base, ctx, ring }: { u: Used; flows: readonly Flow[]; chainId: number; base: string; ctx: Context; ring?: Parameters<typeof RingLink>[0]['ring'] }) {
  const sales = u.sales.map((s, i) => (
    <span key={s.txHash}>
      {i === 0 ? '' : i === u.sales.length - 1 && !u.more ? ' and ' : ', '}
      <Link href={carry(txHref(chainId, s.txHash, base), ctx)} prefetch={false} className="font-medium underline">#{tokenLabel(s.tokenId)}</Link>
    </span>
  ));
  const { use } = u;
  const how = use.method === 'AC'
    ? <>{because(u.witness, chainId, base, true)}.{use.named ? ' It is the one the lens names.' : ''}</>
    : <>It is {flows.some((f) => f.from === use.back[0] && f.to === use.back[1]) ? 'a payment back' : 'on a money path back'} from <Wallet chainId={chainId} address={use.back[0]} within={base} ctx={ctx} /> to <Wallet chainId={chainId} address={use.back[1]} within={base} ctx={ctx} />.</>;
  return (
    <>
      Used by <LensName m={u.use.method} href={carry(lensTabHref(base, u.use.method, { evidence: true }), ctx)} />{u.use.method === 'AU' ? ' (not counted)' : ''} to flag{' '}
      the {u.sales.length === 1 && !u.more ? 'sale' : 'sales'} of {sales}{u.more ? ' and others' : ''}
      {ring === undefined ? null : <>, in <RingLink base={base} ring={ring} ctx={ctx} className="font-medium text-foreground hover:underline" /></>}: {how}
    </>
  );
}

/**
 * A payment opened outside any collection: what it is, and the collections
 * whose lenses use it, each opening it under its tabs. No spot check: a
 * payment moves no token, so there is nothing to check.
 */
export function GlobalPayment({ chainId, tx, flows }: { chainId: number; tx: string; flows: Flow[] }) {
  return (
    <>
      <ParentLine leaf={short(tx)} />
      <Head
        kind="transaction"
        title={<span className="font-mono">{short(tx)}</span>}
        sub={<>Payment on {chainName(chainId)} · <Ext href={explorerTx(chainId, tx)} className="font-mono">{tx}</Ext></>}
      />
      <Answer tone="clean" title="A payment washtrace read as money">
        It is not a token transfer.
        <Facts chainId={chainId} flows={flows} />
      </Answer>
      <Suspense fallback={<Looking />}>
        <GlobalUses chainId={chainId} tx={tx} flows={flows} />
      </Suspense>
    </>
  );
}

/** The watched collections whose lenses use a payment, read after it is shown, each opening it under its tabs. */
export async function GlobalUses({ chainId, tx, flows }: { chainId: number; tx: string; flows: Flow[] }) {
  const usedBy = await store().paymentUsedBy(chainId, flows, null);
  const named = new Map(usedBy.map((u) => [u.collection.address, u.collection]));
  const homes: Home[] = [...named.values()].map((c) => {
    const b = `/c/${chainId}/${c.address}`;
    return { base: b, name: c.name ?? short(c.address), href: txHref(chainId, tx, b) };
  });
  // A collection whose latest analysis predates witnesses stored no use of any payment: none can be said of it.
  const before = homes.length > 0 ? [] : (await store().collections()).filter((c) => c.chainId === chainId && c.latest !== null && c.latest.loops === null);
  return (
    <div className="mt-6 grid gap-3 text-sm">
      <p>
        {homes.length === 0
          ? before.length > 0 ? `The latest analysis of ${andList(before.map((c) => c.name ?? short(c.address)))} ${PREDATES}`
          : `${BUILT_INS} don’t use this payment in any watched collection’s latest analysis.`
          : `${plural(homes.length, 'watched collection')} ${homes.length === 1 ? 'has' : 'have'} a lens that uses it: ${andList(homes.map((h) => h.name))}.`}
      </p>
      <OpenUnder homes={homes} />
    </div>
  );
}
