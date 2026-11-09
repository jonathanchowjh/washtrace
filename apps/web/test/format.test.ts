import { describe, expect, it } from 'vitest';
import { BUILT_IN_NAMES } from '@washtrace/detect';
import { LENSES, notRunAll, interval, lensInfo, num, stageName, tokenLabel, took, floorTime, about, eta } from '@/lib/format';

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

describe('notRunAll', () => {
  it('says one built-in in the words every page uses, and several in the plural, of the latest analysis', () => {
    expect(notRunAll(['AU'])).toBe('Money loops back did not run in the latest analysis, so it flags nothing.');
    expect(notRunAll(['AU', 'AC'])).toBe('Money loops back and Linked wallets did not run in the latest analysis, so they flag nothing.');
  });

  it('across collections, names those whose latest analysis missed them, one or several', async () => {
    const { notRunIn } = await import('@/lib/format');
    expect(notRunIn(['AU'], ['Second'])).toBe('Money loops back did not run in the latest analysis of Second, so it flags nothing there.');
    expect(notRunIn(['AU', 'AC'], ['Second', 'Third'])).toBe('Money loops back and Linked wallets did not run in the latest analyses of Second and Third, so they flag nothing there.');
  });

  it('before any analysis a built-in has not run at all, in the words a lens of yours with no run has', () => {
    expect(notRunAll(['AU'], false)).toBe('Money loops back has not run on this collection, so it flags nothing yet.');
    expect(notRunAll(['AU', 'AC'], false)).toBe('Money loops back and Linked wallets have not run on this collection, so they flag nothing yet.');
  });
});

describe('about and eta, the one rule for a guess', () => {
  const MIN = 60_000;
  it('about rounds to the unit it shows and eta is about plus left', () => {
    expect(about(40 * MIN)).toBe('about 40 min');
    expect(eta(40 * MIN)).toBe('about 40 min left');
    expect([0, 90 * MIN, 36 * 60 * MIN, 3 * 24 * 60 * MIN].map(about)).toEqual(['about 1 min', 'about 2 h', 'about 2 days', 'about 3 days']);
  });
});

describe('floorTime, the "at least T" of an estimate', () => {
  const H = 3_600_000, D = 24 * H;
  it('rounds down at the unit it shows, never up', () => {
    expect(floorTime(20.6 * H)).toBe('20 h');
    expect(floorTime(1.6 * D)).toBe('1 day');
    expect(floorTime(25_000)).toBe('25 s');
  });

  it('switches unit at a minute, an hour and a day, and shows seconds under a minute', () => {
    expect([59_999, 60_000, 60 * 60_000 - 1, H, D - 1, D, 2 * D].map(floorTime)).toEqual(['59 s', '1 min', '59 min', '1 h', '23 h', '1 day', '2 days']);
  });
});
