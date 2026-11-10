import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { COPIES, ruleLine } from '@washtrace/detect/lens-rule';
import { moneyReason, tokensReason } from '@washtrace/detect/lens-reads';
import { LensName, LensPicture } from '@/components/methods';
import { RulePicture } from '@/components/rule-picture';
import { RunsOn, type RunRow } from '@/components/runs-on';
import { TierMark } from '@/components/kit';
import { Head, Problem, STORE_DOWN, Section } from '@/components/ui';
import { LOCAL_ONLY, mayWrite } from '@/lib/auth';
import { LENSES, pctTenth, short } from '@/lib/format';
import { behindOf, needsWords, runStateWords, staleSinceLastWrite } from '@/lib/lens-state';
import { lensTabHref } from '@/lib/links';
import { APART, APART_WHY_TITLE, SHOWN } from '@/lib/metrics';
import { configFromSources, hopsFollowed } from '@/lib/settings';
import { store } from '@/lib/store';

export const metadata: Metadata = { title: 'Lab' };

/** A control that is a link while the console may write, and a disabled button saying why while it may not. */
function Action({ href, writable, className, children }: { href: string; writable: boolean; className?: string; children: ReactNode }) {
  return writable
    ? <Link href={href} className={className ?? 'btn text-xs'}>{children}</Link>
    : <button type="button" disabled title={LOCAL_ONLY} className={className ?? 'btn text-xs'}>{children}</button>;
}

/**
 * The three built-ins as the reference a lens of yours is read against: what
 * each looks for, its standing in the verdict, and its rule in the editor's
 * words. `base` is the first watched collection's path, where a copy of one
 * is written; null when none is watched.
 */
function BuiltIns({ base, writable }: { base: string | null; writable: boolean }) {
  return (
    <Section title="Built-in lenses" lead={`On every collection, read-only. A collection's answer is the range from ${LENSES.A.name} to ${LENSES.AC.name}; ${LENSES.AU.name} is shown apart.`}>
      <ul aria-label="Built-in lenses" className="grid gap-3 md:grid-cols-3">
        {SHOWN.map((m) => (
          <li key={m} data-lens={m} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
            <div className="flex items-start gap-3">
              <LensPicture m={m} />
              <div className="min-w-0">
                <LensName m={m} />
                <span title={APART.includes(m) ? APART_WHY_TITLE : undefined} className="block pl-4 text-xs text-muted-foreground">{LENSES[m].tier}</span>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{LENSES[m].says}</p>
            <p className="text-xs text-muted-foreground">Its rule: {ruleLine(COPIES[m].rule)}</p>
            {base === null ? null : <div className="mt-auto pt-1"><Action href={lensTabHref(base, m, { lens: `copy-${m}` })} writable={writable}>Copy to new lens</Action></div>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The built-ins for reference, then your lenses side by side: each one's rule
 * as a picture and in words, and the watched collections it runs on, ticked
 * to run it on more. Writing or editing a lens, and previewing it, happen on
 * a collection's Methods page, where its data is.
 */
export default async function LabPage() {
  await connection();
  const s = store();
  const head = <Head title="Lab" sub="Your own lenses: a rule each, run on the collections you choose, read beside the three built in." />;
  const loaded = await Promise.all([s.lensRunsAll(), s.collections(), s.sources(), s.settings()]).catch(() => null);
  if (loaded === null) return <>{head}<Problem title={STORE_DOWN}>It could not read your lenses.</Problem></>;
  const [all, collections, sources, settings] = loaded;
  const config = configFromSources(sources, settings);
  const writable = mayWrite(process.env, await headers());
  const first = collections[0];
  const firstBase = first === undefined ? null : `/c/${first.chainId}/${first.address}`;
  const firstName = first === undefined ? '' : first.name ?? short(first.address);
  // The editor lives on a collection's Methods page, where its preview runs on that collection's sales.
  const start = firstBase === null ? null : lensTabHref(firstBase, 'AC', { lens: 'new' });

  if (all.length === 0) {
    return (
      <>
        {head}
        <BuiltIns base={firstBase} writable={writable} />
        <Section title="Your lenses">
          <div className="rounded-lg border border-dashed bg-card p-4 text-sm text-muted-foreground">
            <p>No lens of yours yet. A lens of yours is a rule you set: which transfers count as a way back to the seller, and how far to follow them. Start from blank, or copy a built-in above.</p>
            {start === null ? (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Link href="/" className="btn text-sm">Watch a collection</Link>
                <span>first: a lens is written against a collection&rsquo;s data, on its Methods page.</span>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Action href={start} writable={writable} className="btn text-sm">Write a lens</Action>
                <span>on {firstName}&rsquo;s Methods page, where its preview runs on that collection&rsquo;s sales.</span>
              </div>
            )}
          </div>
        </Section>
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
      <BuiltIns base={firstBase} writable={writable} />
      <Section title="Your lenses" aside={start === null ? null : <span className="flex flex-wrap items-center gap-2"><Action href={start} writable={writable}>+ New lens</Action>on {firstName}, where its preview runs</span>}>
        <div className="space-y-8">
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
              <section key={lens.id} id={lens.key} aria-label={lens.name} className="scroll-mt-6">
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><TierMark tone="own" />{lens.name}</h3>
                <div className="mb-3"><RulePicture rule={lens.rule} /></div>
                <RunsOn lensId={lens.id} rule={lens.rule} rows={rows} writable={writable} />
              </section>
            );
          })}
        </div>
      </Section>
    </>
  );
}
