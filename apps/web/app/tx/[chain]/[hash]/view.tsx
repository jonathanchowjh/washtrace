import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { HEADLINE, lensRefusal } from '@washtrace/detect';
import { ConnectedRail, ParentLine, walletRoles } from '@/components/connected-rail';
import { VerdictChip } from '@/components/kit';
import { WhereItSits } from '@/components/sales-strip';
import { SpotCheck } from '@/components/spot-check';
import { mayWrite } from '@/lib/auth';
import { store } from '@/lib/store';
import { ZERO, type FlaggedTransfer, type Method, type OwnFlag } from '@washtrace/detect';
import { isOwnKey, type LensKey } from '@washtrace/detect/trades';
import { Answer, Ext, Head, Section } from '@/components/ui';
import { LensName } from '@/components/methods';
import { LensGraph } from '@/components/token-graph';
import { Transfers, because, ownBecause } from '@/components/transfers';
import { chainName } from '@/lib/chains';
import { BURN_LINE, BUILT_IN_BEHIND, CAPPED, INTO_CUSTODY_LINE, MINT_LINE, NOT_CAUGHT, NOT_JUDGED_YET, OUT_OF_CUSTODY_LINE, OWN_BEHIND, OWN_NOT_CAUGHT, andList, lensInfo, notRunAll, notRunIn, salesOnlyLine, short, tokenLabel, untimedLine } from '@/lib/format';
import { layout, reasons, type Drawing, type DrawnLoop } from '@/lib/layout';
import { explorerTx, lensTabHref, txHref } from '@/lib/links';
import { OWN_BEFORE_EDIT, behindOf, runStateWords } from '@/lib/lens-state';
import { APART, APART_WHY, NOT_JUDGED, SHOWN, TINT_LEAD, answer, judged, ownRan } from '@/lib/metrics';
import { inEscrow, txView, type TokenDrawing, type TxCollection } from '@/lib/views';
import { Suspense } from 'react';
import { RingChips } from '@/components/rings';
import { StepLine } from '@/components/step-line';

/**
 * The console's form of GET /api/transfers/<chain>/<tx>: is this sale a wash
 * trade, and by which lens. `within`, a collection's base, is the page under
 * that collection's tabs: its links stay inside the collection. Only a
 * transaction whose every transfer is in that collection sits there; any other
 * is sent to its own page, so no row reads as another collection's.
 */
export async function TxView({ chainId, tx, within, from }: { chainId: number; tx: string; within?: string; from?: string }) {
  const v = await txView(chainId, tx);
  const { transfers, washTrade, by, apartOnly, notRun, own, collections, graphs, custody, ownLenses } = v;
  const unread = transfers.length === 0;
  const ownByRow = new Map<string, LensKey[]>();
  for (const f of own) ownByRow.set(`${f.txHash}:${f.logIndex}`, [...(ownByRow.get(`${f.txHash}:${f.logIndex}`) ?? []), `L${f.lensId}`]);
  // Your lenses' catches, said apart: the verdict and its title stay the built-ins', as on the token page.
  const ownNames = [...new Set(own.map((f): LensKey => `L${f.lensId}`))].flatMap((k) => lensInfo(k, ownLenses)?.name ?? []);
  const ownLine = ownNames.length === 0 ? ''
    : ` Your lenses ${washTrade === true || apartOnly ? 'also ' : ''}catch ${transfers.length === 1 ? 'it' : `${ownByRow.size} of its ${transfers.length} transfers`}: ${andList(ownNames)}.`;
  const { title, tone } = unread ? { title: NOT_JUDGED_YET, tone: 'clean' as const } : answer(v, 'Flagged as a wash trade', ownNames.length > 0);
  const body = unread ? 'No watched collection has a transfer in this transaction, so washtrace has not read it. That is not the same as clean.'
    : washTrade === null ? NOT_JUDGED
    : washTrade ? 'The lenses on the right flag it. The reason is beside each transfer below; open its token to see the whole pattern.'
    : apartOnly ? `The lens on the right flags it: ${APART_WHY}. The reason is beside each transfer below.`
    : `Its ${transfers.length === 1 ? 'transfer is' : `${transfers.length} transfers are`} read, and no ${ownNames.length > 0 ? 'built-in ' : ''}lens that ran flags ${transfers.length === 1 ? 'it' : 'them'}.`;
  // The lens names open that lens's tab when the transaction belongs to one collection; across several there is no one tab.
  const homes = new Set(transfers.flatMap((t) => (t.collection ? [`/c/${t.collection.chainId}/${t.collection.address}`] : [])));
  const home = homes.size === 1 ? [...homes][0]! : null;
  if (within !== undefined && home !== within) redirect(txHref(chainId, tx));
  const collection = home === null ? null : transfers.find((t) => t.collection)!.collection!;
  const notRunLine = notRun.length === 0 ? '' : homes.size > 1 ? notRunAcross(notRun, Object.values(collections)) : notRunAll(notRun);
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
      {within === undefined || collection === null ? null : <Suspense fallback={null}><StepLine chainId={chainId} address={collection.address} from={from} of={{ tx }} /></Suspense>}
      {/* Under a collection's tabs its parent line is the layout's; outside them this page draws one the same way. */}
      {within === undefined ? <ParentLine home={collection === null ? undefined : { base: home!, name: collection.name ?? short(collection.address), href: txHref(chainId, tx, home!) }} /> : null}
      <Head
        kind="transaction"
        title={<span className="font-mono">{short(tx)}</span>}
        part={<><VerdictChip tone={unread || v.washTrade === null ? null : tone} />{within !== undefined && collection !== null
          ? <Suspense fallback={null}><RingChips chainId={chainId} address={collection.address} of={{ tx }} /></Suspense> : null}</>}
        sub={<>Transaction on {chainName(chainId)} · <Ext href={explorerTx(chainId, tx)} className="font-mono">{tx}</Ext></>}
      />
      <Answer
        tone={tone}
        title={title}
        aside={by.length > 0 ? (
          // The counted lenses in the console's order; one never counted, set apart under them, so it never reads as a flagger.
          <span className="flex flex-col gap-1">
            {SHOWN.filter((m) => by.includes(m)).map((m) => (
              <span key={m} className={APART.includes(m) && by.some((x) => HEADLINE.includes(x)) ? 'mt-1 border-t border-dashed pt-1.5 text-xs text-muted-foreground' : undefined}>
                <LensName m={m} href={home === null ? undefined : lensTabHref(home, m, { evidence: true })} /> · {TIER[m]}
              </span>
            ))}
          </span>
        ) : undefined}
      >
        {body}{notRunLine && !unread ? ` ${notRunLine}` : ''}{ownLine}
      </Answer>

      {within === undefined || collection === null ? null : <Suspense fallback={null}><WhereItSits chainId={chainId} address={collection.address} of={{ tx }} /></Suspense>}
      {within === undefined || collection === null ? null : <Suspense fallback={null}><ConnectedRail chainId={chainId} address={collection.address} token={new Set(transfers.map((t) => t.tokenId)).size === 1 ? transfers[0]?.tokenId : undefined} wallets={walletRoles(transfers, [], [])} /></Suspense>}
      {unread || washTrade === null ? (
        <SpotCheck chainId={chainId} tx={tx} writable={mayWrite(process.env, await headers())}
          lenses={(await store().lenses()).map((l) => ({ key: l.key, name: l.name, refusal: lensRefusal(l.rule) }))} />
      ) : null}
      {transfers.length > 0 ? <Section title="What it moved" lead={TINT_LEAD}><Transfers chainId={chainId} transfers={transfers} collection within={within} own={ownByRow} names={ownLenses} /></Section> : null}
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
        const cards = alone !== null ? [] : lensCards(t, c, graph === null || drawing === null ? null : { graph, drawing }, own, chainId, base);
        const held = seller === t.from ? '' : `, through custody: ${short(t.from)} held the token for ${short(seller)}, so each lens reads this as a trade from ${short(seller)}`;
        return (
          <Section
            key={`${t.txHash}:${t.logIndex}`}
            title={alone === null ? `How each lens reads ${token}` : alone.title}
            lead={alone !== null ? undefined : `${short(seller)} → ${short(t.to)}${held}. One card per lens says why it caught this transfer or why not; the token’s graph below lights the loop of each that caught it.`}
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
                        {isOwnKey(card.key) ? null : <span data-tier className="text-xs text-muted-foreground">· {TIER[card.key]}</span>}
                      </div>
                      <p className="mt-1 text-sm">
                        {card.line}
                        {card.tab === undefined ? null : <>{' '}<Link href={lensTabHref(base, card.key)} prefetch={false} className="font-medium text-foreground underline">{card.tab}</Link></>}
                      </p>
                    </li>
                  ))}
                </ul>
                {/* The token's graph once, not once a card: a switch lights each catching lens's loop in turn. */}
                {drawing === null || !cards.some((card) => card.caught) ? null : (
                  <div className="mt-3">
                    <LensGraph drawing={drawing} chainId={chainId} base={base} tokenHref={`${base}/t/${t.tokenId}`}
                      caught={cards.filter((card) => card.caught).map((card) => ({ key: card.key, name: lensInfo(card.key, ownLenses)?.name ?? 'this lens', loop: card.loop }))} />
                  </div>
                )}
              </>
            )}
          </Section>
        );
      })}
    </>
  );
}

/** Each built-in's tier, as the verdict chip names it: what it adds to the range, or that it never counts. */
const TIER: Record<Method, string> = { A: 'the floor', AC: 'the ceiling', AU: 'not counted' };

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
 * run here the words of the link to its tab.
 */
interface Card { key: LensKey; line: ReactNode; caught: boolean; loop: DrawnLoop | null; tab?: string }

/**
 * Every lens's card on transfer `t` of collection `c`, whose wallets link
 * under its tabs (`base`): the built-ins, then
 * each lens of yours. A catch lights the loop layout() drew for it, found as
 * the token page finds it: a built-in's is its reason's (`r<i>`, of the
 * reasons holding this row), yours is its flag's (`o<j>`, after them).
 */
function lensCards(t: FlaggedTransfer, c: TxCollection, g: { graph: TokenDrawing; drawing: Drawing } | null, own: readonly OwnFlag[], chainId: number, base: string): Card[] {
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
    return { key: m, line: because(w, chainId, base), caught: true, loop: i < 0 ? null : g!.drawing.loops[i]! };
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
