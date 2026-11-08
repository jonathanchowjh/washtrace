import { describe, expect, it } from 'vitest';
import { BUILT_IN_NAMES } from '@washtrace/detect';
import { DEFAULT_RULE } from '@washtrace/detect/lens-rule';
import { LENSES, floorCauses, notRunAll, interval, lensInfo, num, runStateWords, stageName, tokenLabel, took } from '@/lib/format';

describe('lensInfo', () => {
  it('gives a built-in, one of yours, or null for a key that names neither', () => {
    const own = { L7: { name: 'Blur 3-hop', tone: 'own' as const, says: 'x' } };
    expect(lensInfo('AU', own)).toBe(LENSES.AU);
    expect(lensInfo('L7', own)?.name).toBe('Blur 3-hop');
    expect(lensInfo('L7', {})).toBeNull();
    expect(lensInfo('constructor', {})).toBeNull();
  });
});

describe('format', () => {
  it('keeps the names no lens of yours may take in step with the built-ins\' own', () => {
    expect([...BUILT_IN_NAMES].sort()).toEqual(Object.values(LENSES).map((l) => l.name).sort());
  });

  it('interval reads a repeat in seconds, never in milliseconds, and in minutes from two', () => {
    expect(interval(5_000)).toBe('5 s');
    expect(interval(500)).toBe('0.5 s');
    expect(interval(15_000)).toBe('15 s');
    expect(interval(119_900)).toBe('119.9 s');
    expect(interval(120_000)).toBe('2 min');
    expect(interval(90 * 60_000)).toBe('90 min');
  });

  it('num groups digits the en-US way whatever the container locale', () => {
    expect(num(1234567)).toBe('1,234,567');
    expect(num(12n)).toBe('12');
  });

  it('tokenLabel cuts a long id to max with an ellipsis and leaves a short one', () => {
    expect(tokenLabel('123')).toBe('123');
    expect(tokenLabel('1'.repeat(20))).toBe('1'.repeat(20));
    expect(tokenLabel('1'.repeat(21))).toBe(`${'1'.repeat(18)}…`);
    expect(tokenLabel('1'.repeat(13), 12)).toBe(`${'1'.repeat(10)}…`);
  });

  it('took reads in ms, seconds or minutes, with a space before the unit', () => {
    expect(took(850)).toBe('850 ms');
    expect(took(20_000)).toBe('20 s');
    expect(took(119_499)).toBe('119 s');
    expect(took(119_999)).toBe('2.0 min');
    expect(took(144_000)).toBe('2.4 min');
  });

  it('stageName gives a reading stage its number and label', () => {
    expect(stageName(4)).toBe('reading stage 4 (Chain)');
  });
});

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

describe('notRunAll', () => {
  it('says one built-in in the words every page uses, and several in the plural, of the latest analysis (Ruling S16)', () => {
    expect(notRunAll(['AU'])).toBe('Money loops back did not run in the latest analysis, so it flags nothing.');
    expect(notRunAll(['AU', 'AC'])).toBe('Money loops back and Linked wallets did not run in the latest analysis, so they flag nothing.');
  });

  it('across collections, names those whose latest analysis missed them, one or several (Ruling S17)', async () => {
    const { notRunIn } = await import('@/lib/format');
    expect(notRunIn(['AU'], ['Second'])).toBe('Money loops back did not run in the latest analysis of Second, so it flags nothing there.');
    expect(notRunIn(['AU', 'AC'], ['Second', 'Third'])).toBe('Money loops back and Linked wallets did not run in the latest analyses of Second and Third, so they flag nothing there.');
  });

  it('before any analysis a built-in has not run at all, in the words a lens of yours with no run has', () => {
    expect(notRunAll(['AU'], false)).toBe('Money loops back has not run on this collection, so it flags nothing yet.');
    expect(notRunAll(['AU', 'AC'], false)).toBe('Money loops back and Linked wallets have not run on this collection, so they flag nothing yet.');
  });
});

describe('floorCauses', () => {
  const T = { truncated: 0, untimed: 0 };
  const nftOnly = structuredClone(DEFAULT_RULE);
  for (const k of ['eth', 'internal', 'weth'] as const) nftOnly.edges[k].use = false;
  it('names each cause that makes a share a floor, from the same inputs as atLeastOf', () => {
    expect(floorCauses(DEFAULT_RULE, { truncated: 2, untimed: 0 }, [], true)).toEqual(['some of its searches stopped at the cap before finding a loop']);
    expect(floorCauses(DEFAULT_RULE, { truncated: 0, untimed: 3 }, [], true)).toEqual(['some trades have no block time to judge them by']);
    expect(floorCauses(DEFAULT_RULE, T, ['AC'], true)).toEqual(['money is not fully read yet']);
    expect(floorCauses(DEFAULT_RULE, T, [], false)).toEqual(['no funding source is set, so money is not fully read']);
    expect(floorCauses(DEFAULT_RULE, { truncated: 1, untimed: 1 }, ['AC'], false)).toEqual([
      'some of its searches stopped at the cap before finding a loop', 'some trades have no block time to judge them by', 'no funding source is set, so money is not fully read']);
  });
  it('names nothing for a share that is exact, and no money cause for a lens that follows no money', () => {
    expect(floorCauses(DEFAULT_RULE, T, [], true)).toEqual([]);
    // With counts, for the lens panel: the same words, each count after its cause.
    expect(floorCauses(DEFAULT_RULE, { truncated: 1, untimed: 4 }, [], false, true)).toEqual([
      'some of its searches stopped at the cap before finding a loop (1 search)', 'some trades have no block time to judge them by (4 trades)', 'no funding source is set, so money is not fully read']);
    expect(floorCauses(nftOnly, T, ['AC'], false)).toEqual([]);
  });
});
