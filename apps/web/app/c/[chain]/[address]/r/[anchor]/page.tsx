import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { moneyFor, type Flow } from '@washtrace/detect';
import { EvidenceLine } from '@/components/coverage';
import { ConnectedRail } from '@/components/connected-rail';
import { ringStory, tokenStory, walletRoles } from '@/lib/why';
import { WhereItSits } from '@/components/sales-strip';
import { Answer, Empty, Head, MoreLink, Section } from '@/components/ui';
import { EvidenceGlyph, TierMark, VerdictChip, ringTone } from '@/components/kit';
import { RingLink, RingMembers, type RingMember } from '@/components/rings';
import { TokenLink } from '@/components/transfers';
import { Time } from '@/components/zone';
import { collectionAt } from '@/lib/collection-reads';
import { LABEL_SEP, eth, num, plural, ringName, short, tokenLabel } from '@/lib/format';
import { carry, txHref } from '@/lib/links';
import { counted, toneOf, type Tone } from '@/lib/metrics';
import { fromParam } from '@/lib/step';
import { layout, paidInAll } from '@/lib/layout';
import { RING_DRAWN, ringDrawing, ringEvidence } from '@/lib/views';
import { RingTrail, type TrailRow } from '@/components/token-graph';
import { addressOf } from '@/lib/params';
import { store } from '@/lib/store';
import { tradesHref } from '@/lib/trades-url';
import { cache, Suspense, type ReactNode } from 'react';
import { StepLine } from '@/components/step-line';

type Props = { params: Promise<{ chain: string; address: string; anchor: string }>; searchParams?: Promise<{ from?: string }> };

/** Under a day apart, its first and last trades read as one date. */
const DAY = 86_400_000;

/** Past this many steps the trail lists the first, and the rest are its sales on Trades. */
const TRAIL_MAX = 30;

/** The ring of a collection named by `anchor`, read once a request: its tab title and its page both need it. Cached on the path's words, which both are given. */
const ringAt = cache(async (chain: string, collection: string, at: string) => {
  const anchor = addressOf(at);
  const c = anchor === null ? null : await collectionAt({ chain, address: collection });
  if (anchor === null || c === null) return null;
  const ring = await store().ring(c.id, anchor, { money: moneyFor(c.chainId) });
  return { chainId: c.chainId, address: c.address, anchor, c, ring };
});

async function ringOf({ params }: Props) {
  const p = await params;
  return ringAt(p.chain, p.address, p.anchor);
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const r = await ringOf(props);
  return { title: r?.ring ? `${ringName(r.ring.line)} · ${r.c.name ?? short(r.address)}` : 'Ring' };
}

/**
 * The lens of the evidence a trade of the ring stands for, by its tone (a
 * trade's toneOf, or a bundle's arrow's, the strongest of its trades), which
 * its links carry (?method=) so its token or trade page lights that lens's
 * loop: a loop's is Round trips', a linked pair's Linked wallets'. The ring
 * itself is no one lens's view, so the page reads none.
 */
const lensOf = (tone: Tone | 'own') => (tone === 'cycle' ? 'A' : tone === 'ceiling' ? 'AC' : undefined);

/** A step's row in the trail: its number and amount as the arrow's label says them (LABEL_SEP), what it was, and between whom, when. */
function TrailBody({ n, amount, what, from, to, at }: { n: number; amount: string; what: ReactNode; from: string; to: string; at: ReactNode }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2">
        <span className="font-mono text-xs"><b className="font-semibold">{n}</b>{amount === '' ? null : `${LABEL_SEP}${amount}`}</span>
        <span className="inline-flex items-center gap-1.5">{what}</span>
      </span>
      <span className="block text-xs text-muted-foreground"><span className="font-mono">{short(from)} → {short(to)}</span> · {at}</span>
    </>
  );
}

/** What a member paid or was paid among the ring's evidence payments, in the drawing's words (paidInAll): "paid 11 ETH", "was paid 3.4 WETH", both; null for none. */
function paidWords(address: string, flows: readonly Flow[]): string | null {
  const paid = flows.filter((f) => f.from === address), got = flows.filter((f) => f.to === address);
  const words = [paid.length > 0 ? `paid ${paidInAll(paid)}` : null, got.length > 0 ? `was paid ${paidInAll(got)}` : null].filter((w) => w !== null);
  return words.length === 0 ? null : words.join(' · ');
}

/**
 * One ring, top to bottom: its story in a sentence, what happened drawn in
 * order beside the list of it, who is in it once, its tokens, then where its
 * sales sit and what it is part of. A ring past RING_DRAWN wallets is not
 * drawn: its story is its counts, and its sales are on Trades.
 */
export default async function RingPage(props: Props) {
  await connection();
  const r = await ringOf(props);
  if (r === null) notFound();
  const { chainId, address, anchor, ring } = r;
  const base = `/c/${chainId}/${address}`;
  if (ring === null) return noRing(chainId, address, r.c.id, anchor);
  const { line, wallets, walletsCut, tokens } = ring;
  const from = (await props.searchParams)?.from;
  const sales = tradesHref(base, { ring: anchor });
  // A member opened from here steps through the ring's wallets or tokens, and leads back to it.
  const member = (of: 'wallets' | 'tokens') => fromParam('ring', new URLSearchParams({ anchor, of }), 1);
  // Its loops drawn as a token's are, for a ring small enough to read, numbered in one sequence by time; the members list holds every wallet either way.
  const drawn = walletsCut ? null : await ringDrawing(store(), chainId, r.c, ring);
  const drawing = drawn === null ? null : layout(drawn.transfers, drawn.flows, drawn.middles, [], {}, { numbering: 'time' });
  const evidence = drawn === null ? null : ringEvidence(drawn);
  const story = ringStory(line, evidence);
  // A clean trade between its wallets is drawn, dimmed, but names no one a seller or buyer: roles read the counted trades alone.
  const roles = new Map((drawn === null ? [] : walletRoles(drawn.transfers.filter(counted), drawn.middles)).map((w) => [w.address, w.role]));
  const members: RingMember[] = wallets.map((w) => {
    const sides = [w.sold > 0 ? `${num(w.sold)} sold` : null, w.bought > 0 ? `${num(w.bought)} bought` : null].filter((s) => s !== null);
    const sold = w.sold + w.bought > 0;
    // One in between moved no token: what it paid or was paid of the payments drawn is its part, and a ring not drawn has none to say.
    const paid = sold || drawn === null ? null : paidWords(w.address, drawn.flows);
    return { address: w.address, traded: w.traded, role: roles.get(w.address) ?? (w.traded ? 'traded' : 'in between'), sales: sides.length === 0 ? null : sides.join(' · '), eth: sold ? eth(w.volumeWei) : paid, money: !sold && paid !== null };
  });
  const name = r.c.name ?? short(address);
  // The first loop's picture, else the first pair's, beside the story: loops first, as the lenses are shown.
  const counts = drawn?.transfers.filter(counted) ?? [];
  const glyph = counts.find((t) => t.flags.A)?.flags.A ?? counts.find((t) => t.flags.AC)?.flags.AC;
  const allSales = line.sales === 0 ? null : line.sales === 1 ? 'Its sale on Trades ›' : `All ${num(line.sales)} sales on Trades ›`;

  // Each step of the drawing in order, its links carrying the lens of the evidence it is; a payment is a linked pair's.
  const steps = drawing?.steps ?? [];
  const rows: TrailRow[] = drawn === null ? [] : steps.slice(0, TRAIL_MAX).map((s) => {
    if (s.of === 'transfer') {
      const t = drawn.transfers[s.index]!;
      const kind = t.marketplace ? 'sale' : 'transfer';
      return {
        key: `s${s.n}`, edge: s.edge, nodes: [t.from, t.to], href: carry(txHref(chainId, t.txHash, base), { method: lensOf(toneOf(t)) }), open: `Open ${s.n}, the ${kind} of #${tokenLabel(t.tokenId)}`,
        body: <TrailBody n={s.n} amount={s.amount} from={t.from} to={t.to} at={t.blockTime === null ? `block ${num(t.blockNumber)}` : <Time ms={t.blockTime * 1000} />}
          what={<><TierMark tone={toneOf(t)} label />{t.marketplace ? 'Sale' : 'Transfer'} of #{tokenLabel(t.tokenId)}</>} />,
      };
    }
    const f = drawn.flows[s.index]!;
    return {
      key: `s${s.n}`, edge: s.edge, nodes: [f.from, f.to], href: carry(txHref(chainId, f.txHash, base), { method: 'AC' }), open: `Open ${s.n}, the payment`,
      body: <TrailBody n={s.n} amount={s.amount} from={f.from} to={f.to} at={<Time ms={f.blockTime * 1000} />} what={<span className="text-flow">Payment</span>} />,
    };
  });
  const over = steps.length - rows.length;
  // The figure's links, each its own lens's: an arrow by its key, a payment as a pair's, and its number (by its row) to the same.
  const edgeHrefs: Record<string, string> = Object.fromEntries((drawing?.edges ?? []).flatMap((e) =>
    e.tx === null ? [] : [[e.key, carry(txHref(chainId, e.tx, base), { method: e.kind === 'money' ? 'AC' : lensOf(e.tone) })]]));
  const rowHrefs = Object.fromEntries((drawing?.edges ?? []).flatMap((e) => (e.kind === 'asset' && e.row !== null && edgeHrefs[e.key] !== undefined ? [[e.row, edgeHrefs[e.key]!]] : [])));

  return (
    <>
      <Suspense fallback={null}><StepLine chainId={chainId} address={address} from={from} of={{ ring: anchor }} /></Suspense>
      <Head
        kind="ring" title={ringName(line)}
        sub={<>{plural(line.wallets, 'wallet')} · {plural(line.tokens, 'token')} · <Link href={sales} prefetch={false} className="hover:text-foreground hover:underline">{plural(line.sales, 'sale')}</Link>
          {line.floorSales === 0 ? null : <>{' · '}<Link href={tradesHref(base, { ring: anchor, caught: ['A'] })} prefetch={false} className="hover:text-foreground hover:underline">{plural(line.floorSales, 'round trip')}</Link></>}
          {' · '}<Link href={tradesHref(base, { ring: anchor, sort: 'price', dir: 'desc' })} prefetch={false} className="hover:text-foreground hover:underline">{eth(line.volumeWei)}</Link>
          {line.firstAt === null ? null : line.lastAt! - line.firstAt < DAY ? <> · <Time ms={line.firstAt} style="date" /></> : <> · <Time ms={line.firstAt} style="date" /> to <Time ms={line.lastAt!} style="date" /></>}</>}
        part={<VerdictChip tone={ringTone(line)} />}
      />

      {/* Each block its own card, apart from the next. */}
      <div className="space-y-4">
        <Answer tone={ringTone(line)} title={<span className="flex items-start gap-3">{glyph === undefined ? null : <EvidenceGlyph witness={glyph} className="mt-0.5" />}<span>{story}</span></span>}>
          <p className="text-muted-foreground">
            A ring is wallets the evidence joins, not one person{line.sales === 0 ? '.' : <>; its {line.sales === 1 ? 'sale counts' : 'sales count'} toward <Link href={base} className="underline hover:text-foreground">{name}&rsquo;s share</Link>.</>}
          </p>
          {/* Its traders only: the in-betweens are found in their money, never read themselves. A ring past the list's cut counts the listed ones, as its first. */}
          <Suspense fallback={null}><EvidenceLine chainId={chainId} wallets={wallets.filter((w) => w.traded).map((w) => w.address)} first={walletsCut} home={address} className="mt-2" /></Suspense>
        </Answer>

        {drawing !== null && drawn !== null ? (
          <Section title="What happened">
            <RingTrail drawing={drawing} chainId={chainId} base={base} rows={rows} rowHrefs={rowHrefs} edgeHrefs={edgeHrefs}
              label={`Sales and payments among the wallets of ${ringName(line)}, in order`}
              more={allSales === null ? null : <p className="mt-2 px-1 text-sm">{over > 0 ? `and ${num(over)} more: ` : null}<MoreLink href={sales}>{over > 0 ? 'all its sales on Trades ›' : allSales}</MoreLink></p>} />
          </Section>
        ) : line.sales === 0 ? null : (
          <Section title="What happened">
            <Empty>{line.wallets > RING_DRAWN ? `${plural(line.wallets, 'wallet')} are more than one picture can show.` : 'None of its trades is between two of its wallets.'} <MoreLink href={sales}>{allSales}</MoreLink></Empty>
          </Section>
        )}

        <Section title="Who is in it" lead={walletsCut ? `The first ${num(wallets.length)} of ${num(line.wallets)} are listed.` : undefined}>
          <RingMembers members={members} chainId={chainId} base={base} from={member('wallets')} />
        </Section>

        <Section id="tokens" title="Its tokens" lead={tokens.length > 1 ? 'The most ETH first. Open one for its own graph.' : 'Open it for its own graph.'}>
          {tokens.length === 0 ? <Empty>None of its flagged trades is a counted sale.</Empty> : (
            <ul className="divide-y rounded-lg border bg-card">
              {tokens.map((t) => {
                const w = counts.find((x) => x.tokenId === t.tokenId && x.flags.A)?.flags.A ?? counts.find((x) => x.tokenId === t.tokenId && x.flags.AC)?.flags.AC;
                const tale = tokenStory(evidence?.filter((e) => e.token === t.tokenId) ?? []);
                return (
                  <li key={t.tokenId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                    <TierMark tone={t.floor ? 'cycle' : 'ceiling'} label />
                    {w === undefined ? null : <EvidenceGlyph witness={w} />}
                    <TokenLink base={base} tokenId={t.tokenId} from={member('tokens')} method={t.floor ? 'A' : 'AC'} cardClassName="flex flex-1" className="font-mono font-medium" />
                    <Link href={tradesHref(base, { ring: anchor, token: t.tokenId })} prefetch={false} className="text-xs text-muted-foreground tabular-nums hover:underline">{plural(t.sales, 'sale')}</Link>
                    <Link href={tradesHref(base, { ring: anchor, token: t.tokenId, sort: 'price', dir: 'desc' })} prefetch={false} className="w-20 text-right tabular-nums hover:underline">{eth(t.volumeWei)}</Link>
                    {/* What happened to this token, from its own evidence; a ring not drawn has none to tell. */}
                    {tale === '' ? null : <p className="basis-full text-xs text-muted-foreground">{tale}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Suspense fallback={null}><WhereItSits chainId={chainId} address={address} of={{ ring: anchor }} /></Suspense>
        {/* Its wallets are the members above and its transactions the trail: the rail says what it is part of, once. */}
        <Suspense fallback={null}><ConnectedRail chainId={chainId} address={address} /></Suspense>
      </div>
    </>
  );
}

/**
 * No ring of the latest analysis is named by `anchor`: rings change with each
 * analysis. The ring the wallet is in now is linked, so an old link is never
 * a dead end; one in none says so, and links the list.
 */
async function noRing(chainId: number, address: string, id: number, anchor: string) {
  const base = `/c/${chainId}/${address}`;
  const now = await store().ringsOf(id, { wallet: anchor });
  const lines = now.length === 0 ? [] : await store().ringLines(id, now, { money: moneyFor(chainId) });
  return (
    <>
      <Head kind="ring" title={`The ring of ${short(anchor)}`} />
      {lines.length > 0 ? (
        <Empty>
          Rings changed with the latest analysis: <span className="font-mono">{short(anchor)}</span> is now in{' '}
          {lines.map((l, i) => <span key={l.anchor}>{i === 0 ? null : i === lines.length - 1 ? ' and ' : ', '}<RingLink base={base} ring={l} className="font-medium text-foreground hover:underline">{ringName(l)} ›</RingLink></span>)}
        </Empty>
      ) : (
        <Empty><span className="font-mono">{short(anchor)}</span> is in no ring of the latest analysis. A new analysis can join rings or split them; the list has today&rsquo;s.</Empty>
      )}
      <MoreLink href={`${base}/rings`} className="mt-3">All rings</MoreLink>
    </>
  );
}
