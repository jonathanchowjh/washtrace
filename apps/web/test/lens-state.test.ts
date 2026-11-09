import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { atLeastOf, floorCauses, behindLine, behindOf, staleSinceLastWrite, runStateWords } from '@/lib/lens-state';

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

/** DEFAULT_RULE follows two money edges either way, which is a floor of its own: these tests' lens follows money as it was sent, so only the cause under test makes a floor. */
const ALONG = structuredClone(DEFAULT_RULE);
for (const k of ['eth', 'internal', 'weth'] as const) ALONG.edges[k].direction = 'along';

describe('floorCauses', () => {
  const T = { truncated: 0, untimed: 0 };
  const NO_TOKENS = { reason: null, payees: false };
  // DEFAULT_RULE follows two money edges either way, which is a floor of its own: ALONG follows them as sent.
  const nftOnly = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) nftOnly.edges[k].use = false;
  it('names each cause that makes a share a floor, from the same inputs as atLeastOf', () => {
    expect(floorCauses(ALONG, { truncated: 2, untimed: 0 }, [], true, false, NO_TOKENS)).toEqual(['some of its searches stopped at the cap before finding a loop']);
    expect(floorCauses(ALONG, { truncated: 0, untimed: 3 }, [], true, false, NO_TOKENS)).toEqual(['some trades have no block time to judge them by']);
    expect(floorCauses(ALONG, T, ['AC'], true, false, NO_TOKENS)).toEqual(['money is not fully read yet']);
    expect(floorCauses(ALONG, T, [], false, false, NO_TOKENS)).toEqual(['no funding source is set, so money is not fully read']);
    expect(floorCauses(ALONG, { truncated: 1, untimed: 1 }, ['AC'], false, false, NO_TOKENS)).toEqual([
      'some of its searches stopped at the cap before finding a loop', 'some trades have no block time to judge them by', 'no funding source is set, so money is not fully read']);
  });
  it('names nothing for a share that is exact, and no money cause for a lens that follows no money', () => {
    expect(floorCauses(ALONG, T, [], true, false, NO_TOKENS)).toEqual([]);
    // With counts, for the lens panel: the same words, each count after its cause.
    expect(floorCauses(ALONG, { truncated: 1, untimed: 4 }, [], false, false, NO_TOKENS, true)).toEqual([
      'some of its searches stopped at the cap before finding a loop (1 search)', 'some trades have no block time to judge them by (4 trades)', 'no funding source is set, so money is not fully read']);
    expect(floorCauses(nftOnly, T, ['AC'], false, true, NO_TOKENS)).toEqual([]);
  });
  const MORE = 'money is not read as far as this lens needs';
  const BLIND = 'money is followed only the way it was sent, so a loop against it can be missed';
  it('names money not read as far as the lens needs, after the money causes and only when they are not named', () => {
    expect(floorCauses(ALONG, T, [], true, true, NO_TOKENS)).toEqual([MORE]);
    expect(floorCauses(ALONG, T, ['AC'], true, true, NO_TOKENS)).toEqual(['money is not fully read yet']);
    expect(floorCauses(ALONG, T, [], false, true, NO_TOKENS)).toEqual(['no funding source is set, so money is not fully read']);
    expect(floorCauses(ALONG, { truncated: 1, untimed: 0 }, [], true, true, NO_TOKENS)).toEqual(['some of its searches stopped at the cap before finding a loop', MORE]);
    expect(atLeastOf(ALONG, T, [], true, true, NO_TOKENS)).toBe(true);
    expect(atLeastOf(ALONG, T, [], true, false, NO_TOKENS)).toBe(false);
  });
  it('never names unread money for a lens with no money edge', () => {
    expect(floorCauses(nftOnly, T, [], true, true, NO_TOKENS)).toEqual([]);
    expect(atLeastOf(nftOnly, T, [], true, true, NO_TOKENS)).toBe(false);
  });
  describe('for other tokens', () => {
    const tokensRule = structuredClone(ALONG);
    for (const k of ['eth', 'internal', 'weth'] as const) tokensRule.edges[k].use = false;
    tokensRule.edges['other-tokens'].use = true;
    const NOT_READ = 'other tokens are not read for this collection';
    const NOT_ALL = 'other tokens are not all read yet for this collection';
    const cause = (reason: 'off' | 'seeding' | 'pending' | 'behind' | 'unreached' | null, payees = false) => floorCauses(tokensRule, T, [], true, false, { reason, payees });

    it('names a cause for each reason, in the lens\'s words', () => {
      expect(cause('off')).toEqual([NOT_READ]);
      for (const r of ['seeding', 'pending', 'behind'] as const) expect(cause(r)).toEqual([NOT_ALL]);
      expect(cause('unreached')).toEqual(['other tokens are read only for wallets reached by ETH or WETH, so a loop through tokens can be missed']);
      expect(cause('unreached', true)).toEqual(['other tokens are read only for wallets reached by ETH, WETH or one token payment, so a loop through tokens can be missed']);
      expect(cause(null)).toEqual([]);
    });

    it('makes the share a floor exactly when there is a cause, and adds no money cause for a tokens-only lens', () => {
      expect(atLeastOf(tokensRule, T, [], true, false, { reason: 'off', payees: false })).toBe(true);
      expect(atLeastOf(tokensRule, T, [], true, false, NO_TOKENS)).toBe(false);
      // The money row has nothing to say about it: no funding source is no cause either, as no money edge is on.
      expect(floorCauses(tokensRule, T, ['AC'], false, true, NO_TOKENS)).toEqual([]);
    });

    it('comes after the money causes', () => {
      expect(floorCauses(DEFAULT_RULE, T, [], true, false, { reason: 'off', payees: false })).toEqual([
        'money is followed only the way it was sent, so a loop against it can be missed', NOT_READ]);
    });

    it('never names a token cause in words the lens names would not use (no A, AU or AC)', () => {
      for (const r of ['off', 'seeding', 'unreached'] as const) expect(cause(r).join(' ')).not.toMatch(/\b(A|AU|AC)\b/);
    });
  });

  it('is always a floor when a money edge follows money either way, with its own cause', () => {
    expect(floorCauses(DEFAULT_RULE, T, [], true, false, NO_TOKENS)).toEqual([BLIND]);
    expect(floorCauses(DEFAULT_RULE, T, [], true, true, NO_TOKENS)).toEqual([MORE, BLIND]);
    expect(atLeastOf(DEFAULT_RULE, T, [], true, false, NO_TOKENS)).toBe(true);
    const noMoneyEither = structuredClone(DEFAULT_RULE);
    noMoneyEither.edges.eth.use = false; noMoneyEither.edges.internal.use = false;
    expect(floorCauses(noMoneyEither, T, [], true, false, NO_TOKENS)).toEqual([]);
  });
});

describe('atLeastOf', () => {
  const T = { truncated: 0, untimed: 0 };
  const NO_TOKENS = { reason: null, payees: false };
  const nftOnly = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) nftOnly.edges[k].use = false;

  it('is a floor for a money lens with no funding source, even when the money data is otherwise final (the !funded branch alone)', () => {
    expect(atLeastOf(ALONG, T, [], false, false, NO_TOKENS)).toBe(true);
    expect(atLeastOf(ALONG, T, [], true, false, NO_TOKENS)).toBe(false);
    expect(atLeastOf(nftOnly, T, [], false, false, NO_TOKENS)).toBe(false);
  });

  it('is a floor when money is not final, a search was cut short, or a trade had no block time', () => {
    expect(atLeastOf(ALONG, T, ['AC'], true, false, NO_TOKENS)).toBe(true);
    expect(atLeastOf(nftOnly, T, ['AC'], true, false, NO_TOKENS)).toBe(false);
    expect(atLeastOf(nftOnly, { ...T, truncated: 1 }, [], true, false, NO_TOKENS)).toBe(true);
    expect(atLeastOf(nftOnly, { ...T, untimed: 1 }, [], true, false, NO_TOKENS)).toBe(true);
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
