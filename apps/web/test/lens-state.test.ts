import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { builtinCauses, causeSentence, shareCauses, shareQualifier, behindLine, behindOf, staleSinceLastWrite, runStateWords, type Cause } from '@/lib/lens-state';

describe('runStateWords', () => {
  const run = (status: string, totals: object | null, progress: number | null = null) => ({ status, totals, progress }) as never;
  const words = (r: never, edit: 'edit' | 'analysis' | null = null) => { const w = runStateWords(r, edit); return w === null ? null : [w.short, w.full]; };
  it('gives each run state a short label for the tab and a full phrase for every sentence, as the rest of a sentence that starts with the lens name', () => {
    expect(words(null as never)).toEqual(['not run', 'has not run on this collection, so it flags nothing yet.']);
    expect(words(run('failed', null))).toEqual(['last run failed', 'has no figures: its last run failed.']);
    expect(words(run('queued', null))).toEqual(['first run queued', 'has no figures yet: its first run has not finished.']);
    expect(words(run('running', null))).toEqual(['first run running', 'has no figures yet: its first run has not finished.']);
    expect(words(run('running', null, 0.4))).toEqual(['first run 40%', 'has no figures yet: its first run has not finished.']);
    expect(words(run('queued', {}))).toEqual(['newer run queued', 'has a newer run queued.']);
    expect(words(run('running', {}))).toEqual(['newer run running', 'has a newer run in progress.']);
    expect(words(run('running', {}, 0.4))).toEqual(['newer run 40%', 'has a newer run in progress.']);
    expect(words(run('failed', {}))).toEqual(['last run failed', 'has figures from an earlier run: its last run failed.']);
    expect(words(run('done', {}), 'edit')).toEqual(['before edit', 'shows figures from before its latest edit.']);
  });
  it('says nothing of a finished run that is current', () => {
    expect(runStateWords(run('done', {}))).toBeNull();
  });
  it('says both an edit and a newer run when it can; a failure is said before the edit', () => {
    expect(words(run('queued', {}), 'edit')).toEqual(['before edit · queued', 'shows figures from before its latest edit, and a newer run is queued.']);
    expect(words(run('running', {}, 0.4), 'edit')).toEqual(['before edit · 40%', 'shows figures from before its latest edit, and a newer run is in progress.']);
  });
  it('says a run from before the latest analysis, alone and with a newer run, and a failure before either', () => {
    expect(words(run('done', {}), 'analysis')).toEqual(['before analysis', 'shows figures from the run before the latest analysis.']);
    expect(words(run('queued', {}), 'analysis')).toEqual(['newer run queued', 'shows figures from the run before the latest analysis, and a newer run is queued.']);
    expect(words(run('failed', {}), 'analysis')).toEqual(['last run failed', 'has figures from the run before the latest analysis: its last run failed.']);
    expect(words(run('failed', {}), 'edit')).toEqual(['last run failed', 'has figures from before its latest edit: its last run failed.']);
  });
  it('keeps every tab label short', () => {
    for (const status of ['queued', 'running', 'failed', 'done']) for (const totals of [null, {}]) for (const progress of [null, 0, 0.4, 1]) for (const edit of [null, 'edit', 'analysis'] as const) {
      const w = runStateWords(run(status, totals, progress), edit);
      if (w !== null) expect(w.short.length, `${status} ${totals} ${progress} ${edit}: ${w.short}`).toBeLessThanOrEqual(21);
    }
    expect(runStateWords(null)!.short.length).toBeLessThanOrEqual(21);
  });
});

/** DEFAULT_RULE follows money along; a rule that follows two money edges either way is a floor of its own. */
const EITHER = structuredClone(DEFAULT_RULE);
for (const k of ['eth', 'internal'] as const) EITHER.edges[k].direction = 'either';

describe('shareCauses', () => {
  const T = { truncated: 0, untimed: 0 };
  const NO_TOKENS = { reason: null, payees: false };
  const nftOnly = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) nftOnly.edges[k].use = false;
  const texts = (causes: Cause[]) => causes.map((c) => c.text);
  const CAP = 'some of its searches stopped at the cap before finding a loop';
  const UNTIMED = 'some trades have no block time to judge them by';
  const NO_KEY = 'no funding source is set, so money is not fully read';
  const UNREAD = 'money is not fully read yet';
  it('names each cause of a weaker share, from the same inputs as the qualifier', () => {
    expect(texts(shareCauses(DEFAULT_RULE, { truncated: 2, untimed: 0 }, [], true, true, null, NO_TOKENS))).toEqual([CAP]);
    expect(texts(shareCauses(DEFAULT_RULE, { truncated: 0, untimed: 3 }, [], true, true, null, NO_TOKENS))).toEqual([UNTIMED]);
    expect(texts(shareCauses(DEFAULT_RULE, T, ['AC'], true, true, null, NO_TOKENS))).toEqual([UNREAD]);
    expect(texts(shareCauses(DEFAULT_RULE, T, [], false, false, null, NO_TOKENS))).toEqual([NO_KEY]);
    expect(texts(shareCauses(DEFAULT_RULE, { truncated: 1, untimed: 1 }, ['AC'], false, false, null, NO_TOKENS))).toEqual([CAP, UNTIMED, NO_KEY]);
  });
  const TRAIL_ONLY = 'money past the stored trail is not read without an Etherscan key';
  it('says unchecked wallets are still being read with a key, are not read past a stored trail without one, and with no funding at all that none is set', () => {
    expect(shareCauses(DEFAULT_RULE, T, ['AC'], true, true, null, NO_TOKENS)).toEqual([{ text: UNREAD, bound: false }]);
    expect(shareCauses(DEFAULT_RULE, T, ['AC'], true, false, null, NO_TOKENS)).toEqual([{ text: TRAIL_ONLY, bound: true }]);
    expect(shareCauses(DEFAULT_RULE, T, ['AC'], false, false, null, NO_TOKENS)).toEqual([{ text: NO_KEY, bound: true }]);
    expect(shareQualifier(shareCauses(DEFAULT_RULE, T, ['AC'], true, false, null, NO_TOKENS))).toBe('at least');
    // A trail that checked every wallet leaves nothing unchecked: no money cause.
    expect(shareCauses(DEFAULT_RULE, T, [], true, false, null, NO_TOKENS)).toEqual([]);
  });
  it('names nothing for a share that is exact, and no money cause for a lens that follows no money', () => {
    expect(shareCauses(DEFAULT_RULE, T, [], true, true, null, NO_TOKENS)).toEqual([]);
    // With counts, for the lens panel: the same words, each count after its cause.
    expect(texts(shareCauses(DEFAULT_RULE, { truncated: 1, untimed: 4 }, [], false, false, null, NO_TOKENS, true))).toEqual([`${CAP} (1 search)`, `${UNTIMED} (4 trades)`, NO_KEY]);
    expect(shareCauses(nftOnly, T, ['AC'], false, false, 'pending', NO_TOKENS)).toEqual([]);
  });
  const MORE = 'money is not read as far as this lens needs';
  const BLIND = 'money is followed only the way it was sent, so a loop against it can be missed';
  it('names money not read as far as the lens needs, after the money causes and only when they are not named', () => {
    expect(texts(shareCauses(DEFAULT_RULE, T, [], true, true, 'pending', NO_TOKENS))).toEqual([MORE]);
    expect(texts(shareCauses(DEFAULT_RULE, T, ['AC'], true, true, 'pending', NO_TOKENS))).toEqual([UNREAD]);
    expect(texts(shareCauses(DEFAULT_RULE, T, [], false, false, 'pending', NO_TOKENS))).toEqual([NO_KEY]);
    expect(texts(shareCauses(DEFAULT_RULE, { truncated: 1, untimed: 0 }, [], true, true, 'pending', NO_TOKENS))).toEqual([CAP, MORE]);
  });
  it('never names unread money for a lens with no money edge', () => {
    expect(shareCauses(nftOnly, T, [], true, true, 'limit', NO_TOKENS)).toEqual([]);
  });
  it('marks each cause bound or moving: caps, untimed trades, a missing key, a money limit and either-way money are bound; unread money and money still being read are moving', () => {
    const bound = (causes: Cause[]) => causes.map((c) => c.bound);
    expect(bound(shareCauses(DEFAULT_RULE, { truncated: 1, untimed: 1 }, [], false, false, null, NO_TOKENS))).toEqual([true, true, true]);
    expect(bound(shareCauses(DEFAULT_RULE, T, ['AC'], true, true, null, NO_TOKENS))).toEqual([false]);
    expect(bound(shareCauses(DEFAULT_RULE, T, [], true, true, 'limit', NO_TOKENS))).toEqual([true]);
    for (const r of ['seeding', 'pending', 'behind'] as const) expect(bound(shareCauses(DEFAULT_RULE, T, [], true, true, r, NO_TOKENS)), r).toEqual([false]);
    expect(bound(shareCauses(EITHER, T, [], true, true, null, NO_TOKENS))).toEqual([true]);
  });
  describe('for other tokens', () => {
    const tokensRule = structuredClone(DEFAULT_RULE);
    for (const k of ['eth', 'internal', 'weth'] as const) tokensRule.edges[k].use = false;
    tokensRule.edges['other-tokens'].use = true;
    const NOT_READ = 'other tokens are not read for this collection';
    const NOT_ALL = 'other tokens are not all read yet for this collection';
    const cause = (reason: 'off' | 'seeding' | 'pending' | 'behind' | 'unreached' | null, payees = false) => shareCauses(tokensRule, T, [], true, true, null, { reason, payees });

    it('names a cause for each reason, in the lens\'s words', () => {
      expect(texts(cause('off'))).toEqual([NOT_READ]);
      for (const r of ['seeding', 'pending', 'behind'] as const) expect(texts(cause(r))).toEqual([NOT_ALL]);
      expect(texts(cause('unreached'))).toEqual(['other tokens are read only for wallets reached by ETH or WETH, so a loop through tokens can be missed']);
      expect(texts(cause('unreached', true))).toEqual(['other tokens are read only for wallets reached by ETH, WETH or one token payment, so a loop through tokens can be missed']);
      expect(cause(null)).toEqual([]);
    });

    it('is bound when tokens are off or unreached (waiting will not read them) and moving while they are seeding, pending or behind', () => {
      for (const r of ['off', 'unreached'] as const) expect(shareQualifier(cause(r)), r).toBe('at least');
      for (const r of ['seeding', 'pending', 'behind'] as const) expect(shareQualifier(cause(r)), r).toBe('so far');
      expect(shareQualifier(cause(null))).toBeNull();
    });

    it('adds no money cause for a tokens-only lens', () => {
      // The money row has nothing to say about it: no funding source is no cause either, as no money edge is on.
      expect(shareCauses(tokensRule, T, ['AC'], false, false, 'pending', NO_TOKENS)).toEqual([]);
    });

    it('comes after the money causes', () => {
      expect(texts(shareCauses(EITHER, T, [], true, true, null, { reason: 'off', payees: false }))).toEqual([BLIND, NOT_READ]);
    });

    it('never names a token cause in words the lens names would not use (no A, AU or AC)', () => {
      for (const r of ['off', 'seeding', 'unreached'] as const) expect(texts(cause(r)).join(' ')).not.toMatch(/\b(A|AU|AC)\b/);
    });
  });

  it('is always bound when a money edge follows money either way, with its own cause', () => {
    expect(texts(shareCauses(EITHER, T, [], true, true, null, NO_TOKENS))).toEqual([BLIND]);
    expect(texts(shareCauses(EITHER, T, [], true, true, 'pending', NO_TOKENS))).toEqual([MORE, BLIND]);
    expect(shareQualifier(shareCauses(EITHER, T, [], true, true, null, NO_TOKENS))).toBe('at least');
    const noMoneyEither = structuredClone(DEFAULT_RULE);
    noMoneyEither.edges.eth.use = false; noMoneyEither.edges.internal.use = false;
    expect(shareCauses(noMoneyEither, T, [], true, true, null, NO_TOKENS)).toEqual([]);
  });
});

describe('shareQualifier', () => {
  const T = { truncated: 0, untimed: 0 };
  const NO_TOKENS = { reason: null, payees: false };
  const nftOnly = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) nftOnly.edges[k].use = false;
  const q = (...args: Parameters<typeof shareCauses>) => shareQualifier(shareCauses(...args));

  it('is null for an exact share', () => {
    expect(q(DEFAULT_RULE, T, [], true, true, null, NO_TOKENS)).toBeNull();
    expect(shareQualifier([])).toBeNull();
  });
  it('reads "so far" for a lens with only unread money', () => {
    expect(q(DEFAULT_RULE, T, ['AC'], true, true, null, NO_TOKENS)).toBe('so far');
    expect(q(DEFAULT_RULE, T, [], true, true, 'pending', NO_TOKENS)).toBe('so far');
    expect(q(DEFAULT_RULE, T, [], true, true, 'seeding', NO_TOKENS)).toBe('so far');
    expect(q(DEFAULT_RULE, T, [], true, true, 'behind', NO_TOKENS)).toBe('so far');
  });
  it('reads "at least" for a cap, untimed trades, no funding source or a money limit', () => {
    expect(q(DEFAULT_RULE, { ...T, truncated: 1 }, [], true, true, null, NO_TOKENS)).toBe('at least');
    expect(q(nftOnly, { ...T, truncated: 1 }, [], true, true, null, NO_TOKENS)).toBe('at least');
    expect(q(nftOnly, { ...T, untimed: 1 }, [], true, true, null, NO_TOKENS)).toBe('at least');
    expect(q(DEFAULT_RULE, T, [], false, false, null, NO_TOKENS)).toBe('at least');
    expect(q(DEFAULT_RULE, T, [], true, true, 'limit', NO_TOKENS)).toBe('at least');
    expect(q(nftOnly, T, ['AC'], false, false, 'limit', NO_TOKENS)).toBeNull();
  });
  it('reads "at least" when a moving cause and a bound one both apply, and the panel lists both in order', () => {
    const causes = shareCauses(DEFAULT_RULE, { truncated: 2, untimed: 0 }, ['AC'], true, true, null, NO_TOKENS, true);
    expect(shareQualifier(causes)).toBe('at least');
    expect(causes.map((c) => c.text)).toEqual(['some of its searches stopped at the cap before finding a loop (2 searches)', 'money is not fully read yet']);
    expect(causeSentence(causes)).toBe('Its share is at least this, because some of its searches stopped at the cap before finding a loop (2 searches); money is not fully read yet.');
  });
  it('words the panel sentence for "so far" as a rise still to come, and says nothing for an exact share', () => {
    expect(causeSentence(shareCauses(DEFAULT_RULE, T, ['AC'], true, true, null, NO_TOKENS))).toBe('Its share can still rise while reads finish: money is not fully read yet.');
    expect(causeSentence([])).toBeNull();
  });
});

describe('builtinCauses', () => {
  it('is moving for unchecked wallets with a key, and bound with no funding source', () => {
    expect(shareQualifier(builtinCauses('AC', ['AU', 'AC'], true, true))).toBe('so far');
    expect(shareQualifier(builtinCauses('AC', ['AU', 'AC'], false, false))).toBe('at least');
    expect(builtinCauses('AC', ['AU', 'AC'], false, false).map((c) => c.text)).toEqual(['no funding source is set, so money is not fully read']);
  });
  it('is bound for unchecked wallets past a stored trail with no key, as nothing reads them', () => {
    expect(builtinCauses('AC', ['AU', 'AC'], true, false)).toEqual([{ text: 'money past the stored trail is not read without an Etherscan key', bound: true }]);
    expect(shareQualifier(builtinCauses('AC', ['AU', 'AC'], true, false))).toBe('at least');
  });
  it('has no cause for a lens whose money is not unchecked (Round trips follows none), or when every wallet is checked', () => {
    expect(builtinCauses('A', ['AU', 'AC'], false, false)).toEqual([]);
    expect(builtinCauses('AU', [], false, false)).toEqual([]);
    expect(builtinCauses('AU', [], true, true)).toEqual([]);
  });
});

describe('a lens of yours that is behind', () => {
  const lens = { id: 7, key: 'L7' as const, name: 'Blur 3-hop', rule: DEFAULT_RULE, version: 2, createdAt: 0, updatedAt: 0 };
  const run = (status: string, over: object = {}) => ({ lensId: 7, collectionId: 1, status, lensVersion: 2, analysisId: 5, totals: {}, ...over }) as never;
  const latest = { id: 5 };

  it('is behind after an edit, or after a newer analysis, in any status; the edit is said first', () => {
    for (const status of ['done', 'queued', 'running', 'failed']) {
      expect(behindOf(run(status), lens, latest), status).toBeNull();
      expect(behindOf(run(status, { lensVersion: 1 }), lens, latest), status).toBe('edit');
      expect(behindOf(run(status, { analysisId: 4 }), lens, latest), status).toBe('analysis');
      expect(behindOf(run(status, { lensVersion: 1, analysisId: 4 }), lens, latest), status).toBe('edit');
    }
  });

  it('is never behind with no figures to show: no run, or a run that has not saved', () => {
    expect(behindOf(null, lens, latest)).toBeNull();
    expect(behindOf(run('queued', { totals: null, lensVersion: 1, analysisId: null }), lens, latest)).toBeNull();
    // Figures with no analysis now to match are from one that is gone: behind, by the rule as written.
    expect(behindOf(run('done'), lens, null)).toBe('analysis');
  });

  it('is behind the collection\'s version when written to since the latest analysis, or run on an older one', () => {
    expect(staleSinceLastWrite(run('done'), latest, false)).toBe(false);
    // A reach wallet checked since: the version moved, and no analysis has read it yet.
    expect(staleSinceLastWrite(run('done'), latest, true)).toBe(true);
    // A newer analysis read it, and this run is from the one before.
    expect(staleSinceLastWrite(run('done', { analysisId: 4 }), latest, false)).toBe(true);
    // No figures, no share to floor.
    expect(staleSinceLastWrite(null, latest, true)).toBe(false);
    expect(staleSinceLastWrite(run('queued', { totals: null }), latest, true)).toBe(false);
  });

  it('says each lens behind by name, and why, in one line', () => {
    expect(behindLine([])).toBeNull();
    expect(behindLine([{ name: 'Blur 3-hop', behind: 'edit' }, { name: 'Slow flips', behind: 'analysis' }])).toBe(
      "Blur 3-hop shows figures from before its latest edit, so its flags are the old rule's until the new run saves. "
      + 'Slow flips shows figures from the run before the latest analysis, so trades after it are not judged by it yet.');
  });
});
