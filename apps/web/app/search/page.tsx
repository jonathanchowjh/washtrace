import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { moneyFor, type SearchHits, type SearchKind } from '@washtrace/detect';
import { Empty, Ext, Head, Problem, STORE_DOWN, Section } from '@/components/ui';
import { Pager } from '@/components/pager';
import { short } from '@/lib/format';
import { range, rangeEnds } from '@/lib/metrics';
import { explorerAddress, explorerTx, txHref } from '@/lib/links';
import { addressOf, txOf } from '@/lib/params';
import { hitRow, kindsFor, parseSearch, scopeOf, scopeParam, searchArgs, SEARCH_LIMIT, tooShort, type Scope } from '@/lib/search';
import { KindIcon, RingTag, TierMark, type Kind } from '@/components/kit';
import { store } from '@/lib/store';
import { chainName, explorerOf } from '@/lib/chains';
import { watchedChains } from '@/lib/collection-reads';
import { configFromSources } from '@/lib/settings';

type Props = { searchParams: Promise<{ q?: string; kind?: string; page?: string; scope?: string }> };

const titleOf = (q: string) => (q === '' ? 'Search' : `Search: “${q}”`);

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  return { title: titleOf(((await searchParams).q ?? '').trim()) };
}

/** Each kind's section: the question it answers, and what a row of it is. */
const SECTIONS: Record<SearchKind, { title: string; all: string }> = {
  collections: { title: 'Which watched collections match?', all: 'collections' },
  tokens: { title: 'Which tokens have that number?', all: 'tokens' },
  wallets: { title: 'Which wallets match?', all: 'wallets' },
  trades: { title: 'Which trades are in that transaction?', all: 'trades' },
};

const HINT = 'Type a collection name, a token number (#1234), a wallet address or a transaction hash, or the start of either.';

/**
 * Where /go lands when a search does not name one thing: every kind of hit
 * for what was typed, each cut at 20 and saying so. A kind with more opens
 * on its own page, a page at a time.
 */
export default async function SearchPage({ searchParams }: Props) {
  await connection();
  const sp = await searchParams;
  const q = (sp.q ?? '').trim();
  const parsed = parseSearch(q);
  const { only, page } = searchArgs(sp);
  // A scope names a watched collection, or narrows nothing.
  const asked = scopeOf(sp.scope);
  let c: Awaited<ReturnType<ReturnType<typeof store>['collection']>> = null;
  try {
    c = asked === null ? null : await store().collection(asked.chainId, asked.address);
  } catch { /* the search below says the store is down */ }
  const scope: Scope | null = c === null ? null : { chainId: c.chainId, address: c.address };
  const here = (over: { kind?: SearchKind; page?: number; unscoped?: boolean }) =>
    `/search?q=${encodeURIComponent(q)}${scope && !over.unscoped ? `&scope=${scopeParam(scope)}` : ''}${over.kind ? `&kind=${over.kind}` : ''}${(over.page ?? 1) > 1 ? `&page=${over.page}` : ''}`;
  const head = (
    <Head title={titleOf(q)}
      part={c === null ? undefined : <Link href={here({ unscoped: true })} title="Search every collection" className="chip font-medium hover:bg-muted"><KindIcon kind="collection" className="size-3.5" />In {c.name ?? short(c.address)} <span aria-hidden>✕</span></Link>} />
  );
  if (parsed.kind === 'empty') return <>{head}<Empty>{HINT}</Empty></>;

  const offset = only ? (page - 1) * SEARCH_LIMIT : 0;
  let hits: SearchHits;
  try {
    hits = await store().search(parsed, { offset, only, scope: c === null ? undefined : { id: c.id, chainId: c.chainId } });
  } catch {
    return <>{head}<Problem title={STORE_DOWN}>It could not look up “{q}”.</Problem></>;
  }
  // The ring tag is the results page's alone: ranking rings reads every ring of the collection, once for the wallets shown, never per keystroke in the box.
  const rings = c === null ? new Map<string, number>() : await ringRanks(c, hits);
  const kinds = kindsFor(parsed).filter((k) => hits[k].length > 0);
  // The start of a hash can match several transactions; a whole one is one.
  const title = (k: SearchKind) => (k === 'trades' && parsed.kind === 'prefix' ? 'Which transactions start that way?' : SECTIONS[k].title);

  if (kinds.length === 0) {
    if (only && page > 1) {
      return <>{head}<Empty>That page is past the last result. <Link className="underline" href={here({ kind: only })}>Back to the first page</Link></Empty></>;
    }
    // Only names were searched: what was meant may be a token or a wallet, typed too short to be read as one.
    const reason = tooShort(q);
    if (reason !== null) return <>{head}<Empty>Nothing watched is named “{q}”. {reason}</Empty></>;
    // A pasted hash or address names no chain: it is offered on each watched chain with an explorer (Ethereum's when none is watched). The local chain has none.
    const address = addressOf(q);
    const tx = txOf(q);
    const onChains = address || tx ? (c ? [c.chainId] : await watchedChains()) : [];
    const outside = (onChains.length === 0 ? [1] : onChains).flatMap((id) => {
      const e = explorerOf(id);
      const href = address ? explorerAddress(id, address) : tx ? explorerTx(id, tx) : null;
      return e === null || href === null ? [] : [{ id, href, name: e.name }];
    });
    // A hash no watched collection holds can still be spot checked, on any chain the worker has an RPC for.
    const checkOn = tx ? configFromSources(...await Promise.all([store().sources(), store().settings()])).chains : [];
    return (
      <>
        {head}
        <Empty>
          Nothing watched matches “{q}”. washtrace searches watched collections, their tokens and wallets, and the trades it has read.
          {outside.map((o) => <span key={o.id}> <Ext href={o.href} className="underline">Look it up on {o.name}{outside.length > 1 ? ` (${chainName(o.id)})` : ''}</Ext></span>)}
          {tx !== null && checkOn.length > 0 ? (
            <> Check it on{' '}
              {checkOn.map((c, i) => <span key={c}>{i > 0 ? ', ' : ''}<Link className="underline" href={txHref(c, tx)} prefetch={false}>{chainName(c)}</Link></span>)}
              : washtrace reads that one transaction, without watching its collection.
            </>
          ) : null}
        </Empty>
      </>
    );
  }

  return (
    <>
      {head}
      {kinds.map((k) => (
        <Section key={k} title={`${title(k)} (${hits.more[k] ? `${SEARCH_LIMIT}+` : hits[k].length})`}>
          <ul className="divide-y rounded-lg border bg-card">
            {hits[k].map((_, i) => <Row key={i} hits={hits} kind={k} i={i} scope={scope} ring={k === 'wallets' ? rings.get(hits.wallets[i]!.address) : undefined} />)}
          </ul>
          {/* The store cannot count the rest, so with more behind this page the total is only a lower bound. */}
          {only ? <Pager total={offset + hits[k].length} open={hits.more[k]} page={page} size={SEARCH_LIMIT} href={(n) => here({ kind: only, page: n })} label={SECTIONS[k].all} /> : null}
          {!only && hits.more[k] ? (
            <p className="mt-2 text-sm text-muted-foreground">
              More than {SEARCH_LIMIT}. <Link className="font-medium text-foreground underline" href={here({ kind: k })}>See all {SECTIONS[k].all} →</Link>
            </p>
          ) : null}
        </Section>
      ))}
    </>
  );
}

/**
 * The rank of the highest ring each wallet hit that traded in collection `c` is in: one read of their rings and one ranking of them.
 * A failed read draws no tag; the hits are the answer.
 */
async function ringRanks(c: { id: number; chainId: number }, hits: SearchHits): Promise<Map<string, number>> {
  const ranks = new Map<string, number>();
  const mine = hits.wallets.filter((h) => h.here === true && h.chainId === c.chainId).map((h) => h.address);
  if (mine.length === 0) return ranks;
  try {
    const s = store();
    const anchors = await s.walletRings(c.id, mine);
    const lines = await s.ringLines(c.id, [...new Set([...anchors.values()].flat())], { money: moneyFor(c.chainId) });
    const rank = new Map(lines.map((l) => [l.anchor, l.rank]));
    for (const [address, a] of anchors) {
      const best = Math.min(...a.map((x) => rank.get(x) ?? Infinity));
      if (best !== Infinity) ranks.set(address, best);
    }
  } catch { /* no tag */ }
  return ranks;
}

/** Each kind of hit drawn as the thing it opens: a trade opens its transaction. */
const KIND: Record<SearchKind, Kind> = { collections: 'collection', tokens: 'token', wallets: 'wallet', trades: 'transaction' };

/**
 * What a hit knows besides its title and detail, as a chip: a collection's
 * range of washed sales from its latest analysis (its symbol before the
 * first), a token's flagged trade, whether a wallet traded in the collection
 * searched. A token with none flagged says nothing: it may not be judged yet,
 * which is never shown as clean. A wallet's verdict is its mark beside its title, and a trade carries none.
 */
function chipOf(hits: SearchHits, kind: SearchKind, i: number): string | null {
  if (kind === 'collections') {
    const h = hits.collections[i]!;
    const r = h.totals === null ? null : range(h.totals, 'sales');
    if (r === null) return h.symbol;
    const e = rangeEnds(r);
    return `${e.same ? e.high : `${e.low}–${e.high}`} of sales look washed`;
  }
  if (kind === 'tokens') return hits.tokens[i]!.flagged ? 'Has flagged trades' : null;
  if (kind === 'wallets') {
    const here = hits.wallets[i]!.here;
    return here === undefined ? null : here ? 'Traded here' : 'Never traded here';
  }
  return null;
}

/** One hit: a link led by what names it, what kind of thing it is under that, and what else it knows on the right. */
function Row({ hits, kind, i, scope, ring }: { hits: SearchHits; kind: SearchKind; i: number; scope: Scope | null; ring?: number }) {
  const { href, title, hex, detail, tier } = hitRow(hits, kind, i, scope);
  const chip = chipOf(hits, kind, i);
  return (
    <li>
      <Link href={href} prefetch={false} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-sm hover:bg-muted">
        <span aria-hidden className="grid size-8 place-items-center rounded-md border bg-card text-muted-foreground"><KindIcon kind={KIND[kind]} /></span>
        <span className="min-w-0">
          <span className={`block font-medium text-foreground ${hex ? 'font-mono' : ''}`}>
            {tier === undefined ? null : <TierMark tone={tier} className="mr-1.5 align-baseline" label />}{title}
          </span>
          <span className="block text-xs text-muted-foreground">{detail}{ring === undefined ? null : <> · <RingTag rank={ring} /></>}</span>
        </span>
        {chip === null ? <span /> : <span data-chip className="chip text-muted-foreground">{chip}</span>}
      </Link>
    </li>
  );
}
