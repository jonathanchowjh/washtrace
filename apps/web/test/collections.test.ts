import { describe, expect, it } from 'vitest';
import { RULES } from '@washtrace/detect';
import { configChange, effectiveRules } from '@/lib/collections';

describe('configChange', () => {
  it('passes rules through, with null meaning back to the default', () => {
    expect(configChange({ rules: { minCycles: 3, hubDegree: null } })).toEqual({ rules: { minCycles: 3, hubDegree: null } });
  });

  it('leaves out what was not sent, so it is left alone', () => {
    expect(configChange({ name: 'BAYC' })).toEqual({ name: 'BAYC' });
  });

  it('accepts priority as a boolean', () => {
    expect(configChange({ priority: true })).toEqual({ priority: true });
    expect(configChange({ priority: false })).toEqual({ priority: false });
  });

  it('refuses a priority that is not a boolean', () => {
    expect(configChange({ priority: 'yes' })).toBe('priority must be true or false.');
  });

  it.each([
    [{ rules: { minCycle: 3 } }, 'minCycle'],
    [{ rules: { minCycles: 0 } }, 'minCycles'],
    [{ rules: { minCycles: 2.5 } }, 'minCycles'],
    [{ rules: { minCycles: '3' } }, 'minCycles'],
    [{ rules: [3] }, 'rules'],
    [{ startBlock: 5 }, 'startBlock'],
  ])('refuses %j, naming %s', (body, field) => {
    expect(configChange(body)).toEqual(expect.stringContaining(field));
  });
});

describe('effectiveRules', () => {
  it('lays the overrides over the defaults', () => {
    expect(effectiveRules({ minCycles: 3 })).toEqual({ ...RULES, minCycles: 3 });
  });
});
