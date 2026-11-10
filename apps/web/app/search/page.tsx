import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import type { SearchHits, SearchKind } from '@washtrace/detect';
import { Empty, Ext, Head, Problem, STORE_DOWN, Section } from '@/components/ui';
import { Pager } from '@/components/pager';
import { short } from '@/lib/format';
import { explorerAddress, explorerTx } from '@/lib/links';
import { addressOf, txOf } from '@/lib/params';
import { hitRow, parseSearch, searchArgs, SEARCH_LIMIT } from '@/lib/search';
import { KindIcon, type Kind } from '@/components/kit';
import { store } from '@/lib/store';
import { chainName } from '@/lib/chains';
import { configFromSources } from '@/lib/settings';

type Props = { searchParams: Promise<{ q?: string; kind?: string; page?: string }> };

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

const HINT = 'Type a collection name, a token number (#1234), a wallet address or its start, or a transaction hash.';

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
  const head = <Head title={titleOf(q)} crumb={[{ href: '/', label: 'Collections' }]} />;
  if (parsed.kind === 'empty') return <>{head}<Empty>{HINT}</Empty></>;

  const offset = only ? (page - 1) * SEARCH_LIMIT : 0;
  let hits: SearchHits;
  try {
    hits = await store().search(parsed, { offset, only });
  } catch {
    return <>{head}<Problem title={STORE_DOWN}>It could not look up “{q}”.</Problem></>;
  }
  const here = (over: { kind?: SearchKind; page?: number }) =>
    `/search?q=${encodeURIComponent(q)}${over.kind ? `&kind=${over.kind}` : ''}${(over.page ?? 1) > 1 ? `&page=${over.page}` : ''}`;
  const kinds = (['collections', 'tokens', 'wallets', 'trades'] as const).filter((k) => hits[k].length > 0);

  if (kinds.length === 0) {
    if (only && page > 1) {
      return <>{head}<Empty>That page is past the last result. <Link className="underline" href={here({ kind: only })}>Back to the first page</Link></Empty></>;
    }
    // Chain 1 is the only chain a pasted hash can be looked up on without knowing its chain.
    const address = addressOf(q);
    const tx = txOf(q);
    const outside = address ? explorerAddress(1, address) : tx ? explorerTx(1, tx) : null;
    // A hash no watched collection holds can still be spot checked, on any chain the worker has an RPC for.
    const checkOn = tx ? configFromSources(...await Promise.all([store().sources(), store().settings()])).chains : [];
    return (
      <>
        {head}
        <Empty>
          Nothing watched matches “{q}”. washtrace searches watched collections, their tokens and wallets, and the trades it has read.
          {outside ? <> <Ext href={outside} className="underline">Look it up on Etherscan</Ext></> : null}
          {checkOn.length > 0 ? (
            <> Check it on{' '}
              {checkOn.map((c, i) => <span key={c}>{i > 0 ? ', ' : ''}<Link className="underline" href={`/tx/${c}/${tx}`}>{chainName(c)}</Link></span>)}
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
        <Section key={k} title={`${SECTIONS[k].title} (${hits.more[k] ? `${SEARCH_LIMIT}+` : hits[k].length})`}>
          <ul className="max-w-3xl divide-y rounded-lg border bg-card">
            {hits[k].map((_, i) => <Row key={i} hits={hits} kind={k} i={i} />)}
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

/** Each kind of hit drawn as the thing it opens: a trade opens its transaction. */
const KIND: Record<SearchKind, Kind> = { collections: 'collection', tokens: 'token', wallets: 'wallet', trades: 'transaction' };

/** One hit: a link whose line says what it is, with its address beside it. */
function Row({ hits, kind, i }: { hits: SearchHits; kind: SearchKind; i: number }) {
  const { href, line, address } = hitRow(hits, kind, i);
  return (
    <li>
      <Link href={href} className="flex flex-wrap items-center justify-between gap-x-4 px-3 py-2 text-sm hover:bg-muted">
        <span className="flex items-center gap-2 font-medium text-foreground"><KindIcon kind={KIND[kind]} className="text-muted-foreground" />{line}</span>
        <span className="font-mono text-xs text-muted-foreground">{short(address)}</span>
      </Link>
    </li>
  );
}
