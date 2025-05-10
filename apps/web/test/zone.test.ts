import { describe, expect, it } from 'vitest';
import { midnight, offsetAt, parseZone, validZone } from '@/lib/zone';

describe('zone', () => {
  it('reads a chosen zone, a detected one, and nothing else', () => {
    expect(parseZone('Asia/Singapore')).toEqual({ zone: 'Asia/Singapore', auto: false });
    expect(parseZone('auto:Europe/Berlin')).toEqual({ zone: 'Europe/Berlin', auto: true });
    expect(parseZone('Mars/Olympus')).toBeNull();
    expect(parseZone(undefined)).toBeNull();
    expect(validZone("UTC'; DROP TABLE x;--")).toBeNull();
  });

  it('finds a zone\'s midnight, including on either side of a daylight-saving change', () => {
    expect(midnight(2024, 2, 1, 'Asia/Kolkata')).toBe(Date.UTC(2024, 1, 29, 18, 30));
    // New York: UTC-5 before 10 March 2024, UTC-4 after.
    expect(midnight(2024, 2, 1, 'America/New_York')).toBe(Date.UTC(2024, 2, 1, 5));
    expect(midnight(2024, 3, 1, 'America/New_York')).toBe(Date.UTC(2024, 3, 1, 4));
    expect(offsetAt(Date.UTC(2024, 6, 1), 'America/New_York')).toBe(-4 * 3_600_000);
  });
});
