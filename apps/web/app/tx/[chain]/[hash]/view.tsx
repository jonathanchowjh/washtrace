import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HEADLINE, evidencePayments, lensRefusal, traders } from '@washtrace/detect';
import { ConnectedRail, OpenUnder, ParentLine, type Home } from '@/components/connected-rail';
import { walletRoles } from '@/lib/why';
import { EvidenceGlyph, VerdictChip } from '@/components/kit';
import { WhereItSits } from '@/components/sales-strip';
import { SpotCheck } from '@/components/spot-check';
import { mayWrite } from '@/lib/auth';
import { store } from '@/lib/store';
import { ZERO, type FlaggedTransfer, type Flow, type Method, type OwnFlag, type Witness } from '@washtrace/detect';
import { isOwnKey, type LensKey } from '@washtrace/detect/trades';
import { Answer, Ext, Head, Section } from '@/components/ui';
import { LensName } from '@/components/methods';
import { LensGraph } from '@/components/token-graph';
import { Payments, Transfers, Wallet, because, ownBecause } from '@/components/transfers';
import { chainName } from '@/lib/chains';
import { BURN_LINE, BUILT_IN_BEHIND, LENSES, CAPPED, INTO_CUSTODY_LINE, MINT_LINE, NOT_CAUGHT, NOT_JUDGED_YET, OUT_OF_CUSTODY_LINE, OWN_BEHIND, OWN_NOT_CAUGHT, SHOWN, andList, lensInfo, lensList, notRunAll, notRunIn, salesOnlyLine, short, tokenLabel, untimedLine } from '@/lib/format';
import { layout, reasons, type Drawing, type DrawnLoop } from '@/lib/layout';
import { carry, explorerTx, lensTabHref, txHref, walletHref } from '@/lib/links';
import { OWN_BEFORE_EDIT, behindOf, runStateWords } from '@/lib/lens-state';
import { APART, APART_WHY, NOT_JUDGED, TINT_LEAD, answer, inShownOrder, judged, ownRan } from '@/lib/metrics';
import { inEscrow, txView, type TokenDrawing, type TxCollection } from '@/lib/views';
import { Suspense } from 'react';
import { GlobalPayment, PaymentView } from '@/app/c/[chain]/[address]/tx/[hash]/payment';
import { movesIn, paymentOf } from '@/lib/collection-reads';
import { RingChips } from '@/components/rings';
import { EvidenceLine } from '@/components/coverage';
import { StepLine } from '@/components/step-line';

/**
 * The console's form of GET /api/transfers/<chain>/<tx>: is this sale a wash
 * trade, and by which lens. `within`, a collection's base, is the page under
 * that collection's tabs: its links stay inside the collection. Only a
 * transaction whose every transfer is in that collection sits there; any other
 * is sent to its own page, so no row reads as another collection's. A hash that
 * is no transfer here but a payment washtrace stored opens the payment's view
 * (payment.tsx) instead, under the tabs or outside them, with `address` the
 * collection's.
 */
export async function TxView({ chainId, tx, within, address, from, method }: { chainId: number; tx: string; within?: string; address?: string; from?: string; method?: string }) {
  const v = await txView(chainId, tx);
  const { transfers, washTrade, by, apartOnly, notRun, own, collections, graphs, custody, ownLenses } = v;
  const unread = transfers.length === 0;
  const ownByRow = new Map<string, LensKey[]>();
  for (const f of own) ownByRow.set(`${f.txHash}:${f.logIndex}`, [...(ownByRow.get(`${f.txHash}:${f.logIndex}`) ?? []), `L${f.lensId}`]);
  // Your lenses' catches, said apart: the verdict and its title stay the built-ins', as on the token page.
  const ownNames = [...new Set(own.map((f): LensKey => `L${f.lensId}`))].flatMap((k) => lensInfo(k, ownLenses)?.name ?? []);
  const ownLine = ownNames.length === 0 ? ''
    : ` Your lenses ${washTrade === true || apartOnly ? 'also ' : ''}catch ${transfers.length === 1 ? 'it' : `${ownByRow.size} of its ${transfers.length} transfers`}: ${andList(ownNames)}.`;
  const flaggers = inShownOrder(by).filter((m) => HEADLINE.includes(m));
  const { title, tone } = unread ? { title: NOT_JUDGED_YET, tone: 'clean' as const } : answer(v, 'Flagged as a wash trade', ownNames.length > 0);
  const body = unread ? 'No watched collection has a transfer in this transaction, so washtrace has not read it. That is not the same as clean.'
    : washTrade === null ? NOT_JUDGED
    // Named, not pointed at: the lenses sit beside the answer on a wide screen and under it on a phone.
    : washTrade ? `${lensList(flaggers)} ${flaggers.length === 1 ? 'flags' : 'flag'} it. The reason is beside each transfer below; open its token to see the whole pattern.`
    : apartOnly ? `Only ${LENSES.AU.name} flags it: ${APART_WHY}. The reason is beside each transfer below.`
    : `Its ${transfers.length === 1 ? 'transfer is' : `${transfers.length} transfers are`} read, and no ${ownNames.length > 0 ? 'built-in ' : ''}lens that ran flags ${transfers.length === 1 ? 'it' : 'them'}.`;
  // The lens names open that lens's tab when the transaction belongs to one collection; across several there is no one tab.
  const homes = new Set(transfers.flatMap((t) => (t.collection ? [`/c/${t.collection.chainId}/${t.collection.address}`] : [])));
  const home = homes.size === 1 ? [...homes][0]! : null;
  // A hash that moves no token of this page's collection (of none, outside the tabs) may be a payment washtrace read as money: it has a view of its own.
  // One that moves the collection's tokens is its sale page, whatever else it is.
  if (within === undefined ? unread : address !== undefined && !movesIn(transfers, address)) {
    const flows = await paymentOf(chainId, tx);
    if (flows !== null) return address === undefined || within === undefined ? GlobalPayment({ chainId, tx, flows }) : PaymentView({ chainId, tx, address, flows, ctx: { from, method } });
  }
  if (within !== undefined && home !== within) redirect(txHref(chainId, tx));
  const collection = home === null ? null : transfers.find((t) => t.collection)!.collection!;
  // The wallets its verdict stands on: each transfer's seller (through custody, as the lens cards read it) and buyer, but only the traders the engine queues for money (no mint, burn, marketplace or other contract).
  const sellersAndBuyers = [...new Set(traders(chainId, transfers.map((t, i) => ({ from: custody[i]?.parked != null && custody[i].parked !== t.to ? custody[i].parked : t.from, to: t.to }))))];
  // Outside the tabs: the way into each collection it moved, under its tabs when there is one, else each collection's own page.
  const homeOf = new Map(transfers.flatMap((t) => (t.collection ? [[t.collection.address, t.collection] as const] : [])));
  const ways: Home[] = [...homeOf.values()].map((c) => {
    const b = `/c/${c.chainId}/${c.address}`;
    return { base: b, name: c.name ?? short(c.address), href: homeOf.size === 1 ? txHref(chainId, tx, b) : b };
  });
  // The verdict keeps the API's lens order; the page names lenses floor, ceiling, then the one not counted.
  const notRunLine = notRun.length === 0 ? '' : homes.size > 1 ? notRunAcross(inShownOrder(notRun), Object.values(collections)) : notRunAll(inShownOrder(notRun));
  // One drawing per token, however many of its transfers the transaction moved.
  const drawings = new Map<TokenDrawing, Drawing>();
  const drawingOf = (g: TokenDrawing): Drawing => {
    const known = drawings.get(g);
    if (known !== undefined) return known;
    const d = layout(g.transfers, g.flows, g.middles, g.own, ownLenses);
    drawings.set(g, d);
    return d;
  };
  return (
    <>
      {within === undefined || collection === null ? null : <Suspense fallback={null}><StepLine chainId={chainId} address={collection.address} from={from} method={method} of={{ tx }} /></Suspense>}
      {/* Under a collection's tabs its parent line is the layout's; outside them this page draws one the same way. */}
      {within === undefined ? <ParentLine home={ways.length === 1 ? ways[0] : undefined} leaf={short(tx)} /> : null}
      <Head
        kind="transaction"
        title={<span className="font-mono">{short(tx)}</span>}
        // Not judged, the answer's title says so: a chip saying it again over it would be the page's second "Not judged yet".
        part={<>{unread || v.washTrade === null ? null : <VerdictChip tone={tone} />}{collection !== null
          ? <Suspense fallback={null}><RingChips chainId={chainId} address={collection.address} of={{ tx }} /></Suspense> : null}</>}
        sub={<>Transaction on {chainName(chainId)} · <Ext href={explorerTx(chainId, tx)} className="font-mono">{tx}</Ext></>}
      >
        {within === undefined ? <OpenUnder homes={ways} /> : null}
      </Head>
      <Answer
        tone={tone}
        title={title}
        aside={by.length > 0 ? (
          // The counted lenses in the console's order; one never counted, set apart under them, so it never reads as a flagger.
          <span className="flex flex-col gap-1">
            {SHOWN.filter((m) => by.includes(m)).map((m) => (
              <span key={m} className={APART.includes(m) && by.some((x) => HEADLINE.includes(x)) ? 'mt-1 border-t border-dashed pt-1.5 text-xs text-muted-foreground' : undefined}>
                <LensName m={m} href={home === null ? undefined : lensTabHref(home, m, { evidence: true })} /> · {LENSES[m].tier}
              </span>
            ))}
          </span>
        ) : undefined}
      >
        {body}{notRunLine && !unread ? ` ${notRunLine}` : ''}{ownLine}
        {/* Across several collections there is no one analysis to say, so no line. */}
        {unread || collection === null ? null : <Suspense fallback={null}><EvidenceLine chainId={chainId} wallets={sellersAndBuyers} home={collection.address} block={Math.max(...transfers.map((t) => t.blockNumber))} className="mt-2" /></Suspense>}
      </Answer>

      {/* On a phone the lens cards come right after the verdict, before the panels and the table: their payments sit next to it. Wide, the order is the page's. */}
      <div className="max-lg:flex max-lg:flex-col">
      {/* Its strip, rail and table are cards of their own, apart from the answer and each other. */}
      <div className="mt-4 space-y-4 max-lg:order-2">
      {/* Its one collection's panels, here or under its tabs: a transaction across several has no one strip or rail. */}
      {collection === null ? null : <Suspense fallback={null}><WhereItSits chainId={chainId} address={collection.address} of={{ tx }} /></Suspense>}
      {/* The same members the token page names: the sellers and buyers, and the middles of the transfers' own pairs. */}
      {collection === null ? null : <Suspense fallback={null}><ConnectedRail chainId={chainId} address={collection.address} ctx={{ method }} token={new Set(transfers.map((t) => t.tokenId)).size === 1 ? transfers[0]?.tokenId : undefined} wallets={walletRoles(transfers, [])} /></Suspense>}
      {unread || washTrade === null ? (
        <SpotCheck chainId={chainId} tx={tx} writable={mayWrite(process.env, await headers())}
          lenses={(await store().lenses()).map((l) => ({ key: l.key, name: l.name, refusal: lensRefusal(l.rule) }))} />
      ) : null}
      {transfers.length > 0 ? <Section title="What it moved" lead={TINT_LEAD}><Transfers chainId={chainId} transfers={transfers} collection within={within} ctx={{ method }} own={ownByRow} names={ownLenses} /></Section> : null}
      </div>
      <div className="max-lg:order-1">
      {transfers.map((t, i) => {
        const c = collections[t.collection?.address ?? ''];
        if (c === undefined) return null;
        const graph = graphs[i] ?? null;
        const drawing = graph === null ? null : drawingOf(graph);
        const base = `/c/${c.chainId}/${c.address}`;
        const token = `${c.name ?? short(c.address)} #${tokenLabel(t.tokenId)}`;
        // One line, not a card per lens of lines about a seller and a buyer, for a transfer graph.ts makes no step of: then no lens, built-in
        // or yours, judges it. A burn never is one. A mint is one only when it brings back a token burned before (custody through the zero
        // address), a move into an escrow never, and a move out of one only to a wallet other than the one that put it in (txView's `custody`).
        // Past the burn, a line never hides a catch: `graph` is read exactly when some lens caught it (txView), and then it gets its cards.
        const out = custody[i] ?? null;
        const alone = t.to === ZERO ? ALONE.burn(token)
          : graph !== null ? null
          : inEscrow(t.to) ? ALONE.in(token)
          : t.from === ZERO ? ALONE.mint(token)
          : out !== null && out.parked === null ? ALONE.out(token, OUT_OF_CUSTODY_LINE.unread)
          : out !== null && out.parked === t.to ? ALONE.out(token, OUT_OF_CUSTODY_LINE.back)
          : null;
        // Out of custody to another wallet is that wallet's trade with the one that put the token in, which every card's "seller" means.
        const seller = out?.parked != null && out.parked !== t.to ? out.parked : t.from;
        const cards = alone !== null ? [] : lensCards(t, c, graph === null || drawing === null ? null : { graph, drawing }, own, chainId, base, seller);
        // The token's graph is drawn once a lens caught it; the lead mentions it only then.
        const drawn = drawing !== null && cards.some((card) => card.caught);
        const held = seller === t.from ? '' : `, through custody: ${short(t.from)} held the token for ${short(seller)}, so each lens reads this as a trade from ${short(seller)}`;
        return (
          <Section
            key={`${t.txHash}:${t.logIndex}`}
            title={alone === null ? `How each lens reads ${token}` : alone.title}
            lead={alone !== null ? undefined : `${short(seller)} → ${short(t.to)}${held}. One card per lens says why it caught this transfer or why not${drawn ? '; the token’s graph below lights the loop of each that caught it' : ''}.`}
          >
            {alone !== null ? <p className="text-sm">{alone.line}</p> : (
              <>
                <ul className="grid gap-3 lg:grid-cols-2">
                  {cards.map((card) => (
                    <li key={card.key} data-lens={card.key} className="min-w-0 rounded-lg border bg-card p-3.5">
                      {/* A lens that did not run has no evidence to open: its line links its tab instead. */}
                      <div className="flex flex-wrap items-center gap-x-1.5">
                        <span data-lens-name><LensName m={card.key} own={ownLenses} href={card.tab === undefined ? lensTabHref(base, card.key, { evidence: true }) : undefined} /></span>
                        {/* Each built-in's tier, so a card never reads Money loops back as counted, nor the others as equals. */}
                        {isOwnKey(card.key) ? null : <span data-tier className="text-xs text-muted-foreground">· {LENSES[card.key].tier}</span>}
                      </div>
                      <div className="mt-1 flex items-start gap-3">
                        <p className="min-w-0 flex-1 text-sm">
                          {card.line}
                          {card.tab === undefined ? null : <>{' '}<Link href={lensTabHref(base, card.key)} prefetch={false} className="font-medium text-foreground underline">{card.tab}</Link></>}
                        </p>
                        {card.witness === undefined ? null : <EvidenceGlyph witness={card.witness} />}
                      </div>
                      {card.payments === undefined ? null : <CardPayments of={card.payments} lens={card.key} chainId={chainId} base={base} />}
                    </li>
                  ))}
                </ul>
                {/* The token's graph once, not once a card: a switch lights each catching lens's loop in turn. */}
                {!drawn ? null : (
                  <div className="mt-3">
                    <LensGraph drawing={drawing} chainId={chainId} base={base} ctx={{ method }} tokenHref={`${base}/t/${t.tokenId}`} transfer={t}
                      caught={cards.filter((card) => card.caught).map((card) => ({ key: card.key, name: lensInfo(card.key, ownLenses)?.name ?? 'this lens', loop: card.loop }))} />
                  </div>
                )}
              </>
            )}
          </Section>
        );
      })}
      </div>
      </div>
    </>
  );
}

/** Each built-in's tier, as the verdict chip names it: what it adds to the range, or that it never counts. */

/** The heading and one line of a transfer no lens judges, or none caught: each in place of its lens cards. */
const ALONE = {
  burn: (token: string) => ({ title: `Lenses on the burn of ${token}`, line: BURN_LINE }),
  mint: (token: string) => ({ title: `Lenses on the mint of ${token}`, line: MINT_LINE }),
  in: (token: string) => ({ title: `Lenses on ${token} going into custody`, line: INTO_CUSTODY_LINE }),
  out: (token: string, line: string) => ({ title: `Lenses on ${token} coming out of custody`, line }),
};

/**
 * The answer's not-run line for a transaction across several collections:
 * a lens may have run and flagged in one, so each is said with
 * the collections whose latest analysis missed it, lenses that missed the
 * same ones together. verdict's notRun is any collection's, as its title needs.
 */
function notRunAcross(notRun: readonly Method[], collections: readonly TxCollection[]): string {
  const groups = new Map<string, { methods: Method[]; where: string[] }>();
  for (const m of notRun) {
    const missed = collections.filter((c) => c.latest !== null && !c.latest.totals[m].available);
    const key = missed.map((c) => c.address).join();
    groups.set(key, { methods: [...(groups.get(key)?.methods ?? []), m], where: missed.map((c) => c.name ?? short(c.address)) });
  }
  return [...groups.values()].map((g) => notRunIn(g.methods, g.where)).join(' ');
}

/**
 * One lens's card on one transfer: its one line, whether it caught the
 * transfer and the loop that lights when it did, and for a lens that has not
 * run here the words of the link to its tab. A built-in's catch carries its
 * witness, which the card draws; a lens of yours records none.
 */
interface Card { key: LensKey; line: ReactNode; caught: boolean; loop: DrawnLoop | null; tab?: string; witness?: Witness; payments?: CardPays }

/** The most payments a lens card lists; the rest are the wallet page's. */
const CARD_PAYMENTS = 4;

/** What a card lists of the payments it used: its payments in the drawing's order, each wallet's role, and the seller to open the rest under. */
interface CardPays { flows: Flow[]; roles: Map<string, string>; named?: string; seller: string }

/**
 * The payments a caught built-in used, among the token drawing's: only those
 * its own witness uses (evidencePayments, of this one lens). Round trips names
 * none, so it has no list. Each wallet's role is the seller's or the buyer's,
 * its pair's middle by walletRoles, and any other wallet of a money path in between.
 */
function paymentsOf(m: Method, w: Witness, t: FlaggedTransfer, seller: string, drawn: readonly Flow[]): CardPays | undefined {
  if (m === 'A') return undefined;
  const flows = evidencePayments(drawn, [{ txHash: t.txHash, flags: { [m]: w } }]);
  const named = w.kind === 'pair' ? w.flowTx : undefined;
  const roles = new Map(walletRoles([{ ...t, from: seller, flags: m === 'AC' ? { AC: w } : {} }], []).map((r) => [r.address, r.role]));
  if (m === 'AU') for (const f of flows) for (const a of [f.from, f.to]) if (!roles.has(a)) roles.set(a, 'in between');
  return { flows, roles, named, seller };
}

/**
 * A card's payments, from the heading, up to CARD_PAYMENTS, then how many more.
 * The link to the wallet page's between section is for the first left out, and
 * says how many of the rest are between that pair. Each link carries the
 * card's own lens. Without any, what is true: Linked wallets' are on the
 * seller's page; Money loops back's paths are not listed there.
 */
function CardPayments({ of: p, lens, chainId, base }: { of: CardPays; lens: LensKey; chainId: number; base: string }) {
  const ctx = { method: lens };
  const more = p.flows.slice(CARD_PAYMENTS);
  const next = more[0];
  const pair = (f: Flow) => [f.from, f.to].sort().join();
  const same = next === undefined ? 0 : more.filter((f) => pair(f) === pair(next)).length;
  return (
    <div className="mt-2.5 grid gap-1.5">
      <h3 className="text-xs text-muted-foreground">The payments it used</h3>
      {p.flows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {lens === 'AU' ? 'Its payments are not drawn here.'
            : <>They are not drawn here. They are on <Wallet chainId={chainId} address={p.seller} within={base} ctx={ctx} /> under Who did it move money with.</>}
        </p>
      ) : (
        <Payments chainId={chainId} flows={p.flows.slice(0, CARD_PAYMENTS)} within={base} ctx={ctx} card={{ roles: p.roles, named: p.named }} />
      )}
      {next === undefined ? null : (
        <p className="text-xs">
          <span className="text-muted-foreground">and {more.length} more. </span>
          <Link href={`${carry(`${walletHref(chainId, next.from, base)}?with=${next.to}`, ctx)}#between`} prefetch={false} className="underline">
            {same === more.length ? `Payments between ${short(next.from)} and ${short(next.to)} →` : `${same} of them are between ${short(next.from)} and ${short(next.to)} →`}
          </Link>
          {same === more.length ? null : <span className="text-muted-foreground"> and {more.length - same} more not listed here.</span>}
        </p>
      )}
    </div>
  );
}

/**
 * Every lens's card on transfer `t` of collection `c`, whose wallets link
 * under its tabs (`base`): the built-ins, then
 * each lens of yours. A catch lights the loop layout() drew for it, found as
 * the token page finds it: a built-in's is its reason's (`r<i>`, of the
 * reasons holding this row), yours is its flag's (`o<j>`, after them).
 */
function lensCards(t: FlaggedTransfer, c: TxCollection, g: { graph: TokenDrawing; drawing: Drawing } | null, own: readonly OwnFlag[], chainId: number, base: string, seller: string): Card[] {
  const same = (x: { txHash: string; logIndex: number }) => x.txHash === t.txHash && x.logIndex === t.logIndex;
  const row = g === null ? 0 : g.graph.transfers.findIndex(same) + 1;
  const why = g === null ? [] : reasons(g.graph.transfers);
  const builtIns = SHOWN.map((m): Card => {
    if (c.latest !== null && !c.latest.totals[m].available) return { key: m, line: notRunAll([m]), caught: false, loop: null, tab: 'See why on its tab →' };
    if (!judged(t, c.latest)) return { key: m, line: BUILT_IN_BEHIND, caught: false, loop: null };
    const w = t.flags[m];
    // Money loops back's searches are the built-ins' only capped ones.
    if (w === undefined) return { key: m, line: `${NOT_CAUGHT[m]}${m === 'AU' && (c.latest?.truncatedSearches ?? 0) > 0 ? CAPPED : ''}`, caught: false, loop: null };
    const i = why.findIndex((r) => r.methods.includes(m) && r.rows.includes(row));
    return { key: m, line: because(w, chainId, base, false, { method: m }), caught: true, loop: i < 0 ? null : g!.drawing.loops[i]!, witness: w, payments: paymentsOf(m, w, t, seller, g === null ? [] : g.graph.flows) };
  });
  const ran = ownRan(c.runs);
  const yours = c.runs.map(({ lens, run }): Card => {
    const key = lens.key;
    // No run, or a queued, running or failed first one: no figures, and nothing flagged yet. The tab runs it, follows it or says why it failed.
    if (run === null || !ran.includes(key)) {
      return { key, line: `${lens.name} ${runStateWords(run)!.full}`, caught: false, loop: null, tab: run === null ? 'Run it from its tab →' : run.status === 'failed' ? 'See why on its tab →' : 'Follow it on its tab →' };
    }
    if (run.throughBlock !== null && t.blockNumber > run.throughBlock) return { key, line: OWN_BEHIND, caught: false, loop: null };
    const f = own.find((x) => x.collectionId === c.id && x.lensId === lens.id && same(x));
    const capped = (run.totals?.truncated ?? 0) > 0 ? CAPPED : '';
    // Its flags are another rule's until the new run saves, so the rule it has now says nothing of what that run judged.
    if (f === undefined && behindOf(run, lens, c.latest) === 'edit') return { key, line: `${OWN_BEFORE_EDIT}${capped}`, caught: false, loop: null };
    // What runLens never judges (lens.ts `judges`), so its miss line would be false: a non-sale under a sales-only rule, and an untimed trade under a window or loop order.
    if (f === undefined && lens.rule.judges === 'sales' && t.marketplace === null) return { key, line: salesOnlyLine(lens.name), caught: false, loop: null };
    if (f === undefined && t.blockTime === null && (lens.rule.window !== null || lens.rule.order === 'loop')) return { key, line: untimedLine(lens.name, lens.rule), caught: false, loop: null };
    if (f === undefined) return { key, line: `${OWN_NOT_CAUGHT}${capped}`, caught: false, loop: null };
    const j = g === null ? -1 : g.graph.own.findIndex((x) => x.lensId === lens.id && same(x));
    return { key, line: ownBecause(f), caught: true, loop: j < 0 ? null : g!.drawing.loops[why.length + j]! };
  });
  return [...builtIns, ...yours];
}
