import { describe, expect, it } from 'vitest';
import { interval, num, stageName, tokenLabel, took } from '@/lib/format';

describe('format', () => {
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
