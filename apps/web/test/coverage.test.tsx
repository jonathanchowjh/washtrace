import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectionRow } from '@washtrace/detect';
import { ReadingPanel, ReadingSummary } from '@/components/coverage';
import { coverage } from '@/lib/metrics';

afterEach(cleanup);

const row = (more: Partial<CollectionRow> = {}) => ({
  id: 1, chainId: 1, address: '0xabc', name: 'Demo', startBlock: 1, cursorBlock: 10, headBlock: 10, transfers: 5,
  wallets: 0, fundedWallets: 0, latest: null, error: null, stale: false, pausedAt: null, priority: false, ...more,
}) as unknown as CollectionRow;

function panel(c: CollectionRow) {
  return render(<ReadingPanel c={c} cov={coverage(c)} why="Waiting" />).container;
}

describe('ReadingPanel step 1', () => {
  it('says a caught-up paused collection was read when paused', () => {
    expect(panel(row({ pausedAt: 5 })).textContent).toContain('5 transfers · read to block 10 when paused');
  });

  it('says a never-read paused collection is not read yet', () => {
    const text = panel(row({ pausedAt: 5, transfers: 0, cursorBlock: 0 })).textContent!;
    expect(text).toContain('Not read yet · paused');
    expect(text).not.toContain('unread');
  });

  it('never prints "0 blocks unread" when the head is unknown', () => {
    const text = panel(row({ headBlock: null, transfers: 0, cursorBlock: 0 })).textContent!;
    expect(text).toContain('head not known yet');
    expect(text).not.toContain('0 blocks');
  });
});

describe('loading stored data', () => {
  it('leads the page with how far the load has got, as a bar', () => {
    const c = row({ cursorBlock: null, startBlock: null, restoreProgress: 0.42 });
    const text = render(<ReadingSummary c={c} cov={coverage(c)} href="#reading" />).container.textContent!;
    expect(text).toContain('42%');
    expect(text).toContain('Loading stored data');
    expect(panel(c).textContent).toContain('Loading stored data · 42%');
  });

  it('says why stored data was not loaded beside step 1, as information and not a fault', () => {
    const note = 'Stored data could not be loaded (checksum differs); reading from the chain instead.';
    const el = panel(row({ restoreNote: note }));
    const line = [...el.querySelectorAll('p')].find((p) => p.textContent === note)!;
    expect(line).toBeTruthy();
    expect(line.className).not.toContain('text-fault');
  });
});

describe('bars', () => {
  it('are never green for a paused collection, whatever the share', () => {
    const c = row({ pausedAt: 5 });
    const a = render(<ReadingPanel c={c} cov={coverage(c)} why="Waiting" />).container;
    const b = render(<ReadingSummary c={c} cov={coverage(c)} href="#reading" />).container;
    expect(a.querySelector('.bg-ok')).toBeNull();
    expect(b.querySelector('.bg-ok')).toBeNull();
  });

  it('are green once a live collection is fully read', () => {
    const c = row();
    expect(render(<ReadingSummary c={c} cov={coverage(c)} href="#reading" />).container.querySelector('i.bg-ok')).not.toBeNull();
  });
});
