import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { moneyReason, tokensReason } from '@washtrace/detect/lens-reads';
import { RulePicture } from '@/components/rule-picture';
import { RunsOn, type RunRow } from '@/components/runs-on';
import { TierMark } from '@/components/kit';
import { Empty, Head, Problem, STORE_DOWN, Section } from '@/components/ui';
import { mayWrite } from '@/lib/auth';
import { pctTenth, short } from '@/lib/format';
import { behindOf, needsWords, runStateWords, staleSinceLastWrite } from '@/lib/lens-state';
import { lensTabHref } from '@/lib/links';
import { configFromSources, hopsFollowed } from '@/lib/settings';
import { store } from '@/lib/store';

export const metadata: Metadata = { title: 'Lab' };

/**
 * Your lenses side by side: each one's rule as a picture and in words, and
 * the watched collections it runs on, ticked to run it on more. Writing or
 * editing a lens, and previewing it, happen on a collection's Methods page,
 * where its data is.
 */
export default async function LabPage() {
  await connection();
  const s = store();
  const head = <Head title="Lab" sub="Your own lenses: a rule each, run on the collections you choose. The built-ins are on every collection's Methods page." />;
  const loaded = await Promise.all([s.lensRunsAll(), s.collections(), s.sources(), s.settings()]).catch(() => null);
  if (loaded === null) return <>{head}<Problem title={STORE_DOWN}>It could not read your lenses.</Problem></>;
  const [all, collections, sources, settings] = loaded;
  const config = configFromSources(sources, settings);
  const writable = mayWrite(process.env, await headers());
  const first = collections[0];
  const start = first === undefined ? null : lensTabHref(`/c/${first.chainId}/${first.address}`, 'AC', { lens: 'new' });
  if (all.length === 0) {
    return (
      <>
        {head}
        <Empty>No lens of yours yet. {start === null ? 'Watch a collection first: a lens is written against its data.' : <><Link href={start} className="underline">Write one</Link> on {first!.name ?? short(first!.address)}&rsquo;s Methods page, where its preview runs on that collection&rsquo;s sales.</>}</Empty>
      </>
    );
  }
  // How far each collection's money and other tokens are read: one read each, for every lens's row.
  const hops = hopsFollowed(config);
  const reads = await Promise.all(collections.map(async (c) => ({
    money: await s.moneyRead(c.id, hops).catch(() => null),
    tokens: c.readTokens ? await s.tokenCounts(c.id).catch(() => null) : null,
  })));

  return (
    <>
      {head}
      {start === null ? null : <p className="-mt-2 mb-2 text-sm"><Link href={start} className="font-medium underline">+ New lens</Link> <span className="text-muted-foreground">on {first!.name ?? short(first!.address)}, where its preview runs</span></p>}
      {all.map(({ lens, runs }) => {
        const rows: RunRow[] = collections.map((c, i) => {
          const base = `/c/${c.chainId}/${c.address}`;
          const run = runs.get(c.id) ?? null;
          const read = reads[i]!;
          const behind = behindOf(run, lens, c.latest);
          const money = read.money === null ? null : moneyReason(lens.rule, read.money, hops, staleSinceLastWrite(run, c.latest, c.stale));
          const tokens = tokensReason(lens.rule, c.readTokens, read.tokens, run?.tokensRead ?? null);
          return {
            chainId: c.chainId, address: c.address, name: c.name ?? short(c.address),
            tab: lensTabHref(base, lens.key, { evidence: true }), edit: lensTabHref(base, lens.key, { lens: `edit-${lens.key}` }),
            state: run === null ? 'not run here' : behind === null && run.totals !== null && run.status === 'done' ? null : runStateWords(run, behind)?.short ?? null,
            share: run?.totals == null ? null : `${pctTenth(run.totals.flaggedSales, run.totals.sales)} of sales`,
            needs: needsWords(money, tokens),
            busy: run !== null && (run.status === 'queued' || run.status === 'running'),
          };
        });
        return (
          <Section key={lens.id} id={lens.key} title={lens.name}>
            <div className="mb-3 flex items-start gap-2"><TierMark tone="own" className="mt-1.5" /><RulePicture rule={lens.rule} /></div>
            <RunsOn lensId={lens.id} rows={rows} writable={writable} />
          </Section>
        );
      })}
    </>
  );
}
