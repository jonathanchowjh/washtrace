import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { METHODS } from '@washtrace/detect';
import { Head, Section } from '@/components/head';
import { MethodTable, Trend } from '@/components/methods';
import { Refresh } from '@/components/refresh';
import { Wallet } from '@/components/transfers';
import { StopWatching } from '@/components/watch';
import { addressOf, chainOf, methodOf } from '@/lib/api';
import { chainName } from '@/lib/chains';
import { METHOD_NAMES, clock, explorer, pct, plural, short } from '@/lib/format';
import { store } from '@/lib/store';
import { cn } from '@/lib/utils';

type Props = { params: Promise<{ chain: string; address: string }>; searchParams: Promise<{ method?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return { title: short(address) };
}

/**
 * One collection: each method's share (the paper's Table 4, for this
 * collection), how that share moved as funding filled in, and the tokens and
 * wallets the selected method flags most.
 */
export default async function CollectionPage({ params, searchParams }: Props) {
  await connection();
  const p = await params;
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  if (chainId === null || address === null) notFound();
  const s = store();
  const c = await s.collection(chainId, address);
  if (!c) notFound();
  const method = methodOf((await searchParams).method);
  const [history, tokens, wallets] = await Promise.all([s.history(c.id), s.topTokens(c.id, method, 25), s.topWallets(c.id, method, 25)]);
  const base = `/c/${chainId}/${address}`;
  const a = c.latest;

  return (
    <>
      <Head
        title={c.name ?? short(address)}
        crumb={[{ href: '/', label: 'Collections' }]}
        sub={<>{chainName(chainId)} · <a className="font-mono hover:underline" href={`${explorer(chainId)}/address/${address}`} target="_blank" rel="noreferrer">{address}</a></>}
      >
        <Refresh />
        <StopWatching chainId={chainId} address={address} />
      </Head>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Read through block" value={c.cursorBlock?.toLocaleString() ?? '—'} note={c.headBlock === null ? 'finalized head unknown' : `finalized head ${c.headBlock.toLocaleString()}`} />
        <Fact label="Transfers read" value={c.transfers.toLocaleString()} note={a ? `${plural(a.totals.A.sales, 'sale')} among them` : 'not analyzed yet'} />
        <Fact label="Funding read" value={a ? pct(a.fundedWallets, a.wallets) : '—'} note={a ? `${a.fundedWallets.toLocaleString()} of ${a.wallets.toLocaleString()} wallets` : ''} />
        <Fact label="Missing data" value={a ? `${(a.missingData * 100).toFixed(2)}%` : '—'} note="transfers whose sender was not the last receiver" />
      </dl>
      {c.error ? <p className="mt-3 text-xs text-cycle">Last ingest failed: {c.error}</p> : null}

      <Section title="Wash trade share by method" aside={a ? `analyzed ${clock(a.ranAt)} in ${a.tookMs} ms${c.stale ? ' · new data waiting' : ''}` : undefined}>
        {a ? <MethodTable totals={a.totals} selected={method} href={(m) => `${base}?method=${m}`} /> : (
          <p className="rounded-md border bg-card p-4 text-muted-foreground">The worker has not analyzed this collection yet. It does once its first transfers are read.</p>
        )}
        {a && a.fundedWallets < a.wallets ? (
          <p className="mt-2 text-xs text-muted-foreground">
            SCC AU and AC read money for {pct(a.fundedWallets, a.wallets)} of wallets so far, so their shares are a floor and rise as funding is read, busiest wallets first.
          </p>
        ) : null}
        {a && a.truncatedSearches > 0 ? <p className="mt-1 text-xs text-money">{plural(a.truncatedSearches, 'money search')} stopped at the visit cap before depth 30.</p> : null}
      </Section>

      {history.length > 1 ? <Section title="Across analyses"><Trend history={history} /></Section> : null}

      <nav aria-label="Method" className="mt-6 flex gap-1 border-b">
        {METHODS.map((m) => (
          <Link key={m} href={`${base}?method=${m}`} aria-current={m === method ? 'page' : undefined}
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 font-mono text-xs aria-[current=page]:border-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground">
            {METHOD_NAMES[m]}
          </Link>
        ))}
      </nav>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Tokens most flagged" aside={`by ${METHOD_NAMES[method]}`}>
          <Ranked
            rows={tokens.map((t) => ({ key: t.tokenId, label: <Link href={`${base}/t/${t.tokenId}`} className="font-mono hover:underline">#{t.tokenId.length > 14 ? `${t.tokenId.slice(0, 12)}…` : t.tokenId}</Link>, flagged: t.flagged, of: t.transfers }))}
            tone={method === 'A' ? 'cycle' : 'money'}
          />
        </Section>
        <Section title="Wallets most flagged" aside={`transfers sent or received, by ${METHOD_NAMES[method]}`}>
          <Ranked
            rows={wallets.map((w) => ({ key: w.address, label: <Wallet chainId={chainId} address={w.address} />, flagged: w.flagged, of: w.transfers }))}
            tone={method === 'A' ? 'cycle' : 'money'}
          />
        </Section>
      </div>
    </>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-base text-foreground tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{note}</dd>
    </div>
  );
}

function Ranked({ rows, tone }: { rows: { key: string; label: React.ReactNode; flagged: number; of: number }[]; tone: 'cycle' | 'money' }) {
  if (rows.length === 0) return <p className="rounded-md border bg-card p-4 text-muted-foreground">Nothing flagged by this method.</p>;
  const max = Math.max(...rows.map((r) => r.flagged));
  return (
    <ol className="rounded-md border bg-card">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_7rem_6rem] items-center gap-3 border-b px-3 py-1.5 last:border-b-0">
          <span className="truncate">{r.label}</span>
          <span aria-hidden className="h-1.5 rounded-full bg-muted">
            <i className={cn('block h-full rounded-full', tone === 'cycle' ? 'bg-cycle' : 'bg-money')} style={{ width: `${(r.flagged / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs tabular-nums">{r.flagged} of {r.of}</span>
        </li>
      ))}
    </ol>
  );
}
