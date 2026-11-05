import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Empty, Head } from '@/components/head';
import { LensName, Ranked } from '@/components/methods';
import { Pager } from '@/components/pager';
import { Wallet } from '@/components/transfers';
import { addressOf, chainOf, methodOf } from '@/lib/api';
import { LENSES, short } from '@/lib/format';
import { store } from '@/lib/store';
import { cn } from '@/lib/utils';

const PAGE = 50;

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ method?: string; kind?: string; page?: string }> };

export const metadata: Metadata = { title: 'Flagged' };

/**
 * Every token or wallet one lens flags, a page at a time: the collection
 * page's top ten, continued. Lens and kind stay in the URL, so a page can be
 * shared and the way back keeps the same lens.
 */
export default async function FlaggedPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const q = await searchParams;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) notFound();
  const method = methodOf(q.method);
  const kind = q.kind === 'wallets' ? 'wallets' : 'tokens';
  const total = c.latest?.totals[method][kind] ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1));
  const offset = (page - 1) * PAGE;
  const base = `/c/${chainId}/${address}`;
  const name = c.name ?? short(address);
  const lens = LENSES[method];
  const href = (over: { method?: string; kind?: string; page?: number }) =>
    `${base}/flagged?method=${over.method ?? method}&kind=${over.kind ?? kind}${(over.page ?? 1) > 1 ? `&page=${over.page}` : ''}`;

  const rows = kind === 'tokens'
    ? (await s.topTokens(c.id, method, PAGE, offset)).map((r) => ({ key: r.tokenId, label: <Link href={`${base}/t/${r.tokenId}`} className="font-mono font-medium text-foreground hover:underline">#{r.tokenId.length > 24 ? `${r.tokenId.slice(0, 22)}…` : r.tokenId}</Link>, flagged: r.flagged, of: r.transfers }))
    : (await s.topWallets(c.id, method, PAGE, offset)).map((r) => ({ key: r.address, label: <Wallet chainId={chainId} address={r.address} />, flagged: r.flagged, of: r.transfers }));

  return (
    <>
      <Head
        title={`${kind === 'tokens' ? 'Tokens' : 'Wallets'} flagged by ${lens.name}`}
        crumb={[{ href: '/', label: 'Collections' }, { href: `${base}?method=${method}`, label: name }]}
        sub={`${total.toLocaleString()} in all, most flagged first. ${kind === 'tokens' ? 'Open a token to see why each trade was flagged.' : 'Open a wallet to see its trades and who it moved money with.'}`}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Lens" className="flex flex-wrap gap-1.5">
          {METHODS.map((m) => (
            <Link key={m} href={href({ method: m })} aria-current={m === method ? 'page' : undefined}
              className={cn('rounded-md border px-2.5 py-1 text-sm', m === method ? 'bg-card ring-1 ring-foreground' : 'bg-muted/50 hover:bg-card')}>
              <LensName m={m} />
            </Link>
          ))}
        </nav>
        <nav aria-label="Show" className="flex rounded-md border bg-card p-0.5 text-sm">
          {(['tokens', 'wallets'] as const).map((k) => (
            <Link key={k} href={href({ kind: k })} aria-current={k === kind ? 'page' : undefined}
              className={cn('rounded px-3 py-1', k === kind ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {k === 'tokens' ? 'Tokens' : 'Wallets'}
            </Link>
          ))}
        </nav>
      </div>

      <div className="mt-4 max-w-3xl">
        {c.latest === null || !c.latest.totals[method].available ? (
          <Empty>{lens.name} has not run on this collection, so it flags nothing yet.</Empty>
        ) : (
          <Ranked
            title={kind === 'tokens' ? 'Tokens' : 'Wallets'} unit={kind === 'tokens' ? 'trades' : 'trades it was in'}
            empty={`${lens.name} flags no ${kind === 'tokens' ? 'token' : 'wallet'}.`}
            rows={rows} tone={lens.tone} start={offset}
          />
        )}
      </div>

      {pages > 1 ? <div className="max-w-3xl"><Pager total={total} page={page} size={PAGE} href={(n) => href({ page: n })} label={kind} /></div> : null}
    </>
  );
}
