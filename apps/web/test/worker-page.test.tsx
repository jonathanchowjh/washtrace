import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '@/lib/status';

const state = { notices: [] as Notice[] };
const job = (j: string) => ({ job: j, state: 'ok', startedAt: null, finishedAt: null, tookMs: null, outcome: null, detail: null });
vi.mock('@/lib/views', () => ({
  workerView: async () => ({
    every: { ingest: 60_000, fund: 60_000, analyze: 60_000, lens: 60_000 }, rpcChains: [1], funding: null, followHops: null, trailFunded: false,
    passes: [], jobs: ['ingest', 'fund', 'analyze', 'lens'].map(job), notices: state.notices, backlog: [], collections: [],
  }),
}));
vi.mock('@/lib/api', () => ({ readerZone: async () => 'UTC' }));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => { cleanup(); state.notices = []; });

async function draw(): Promise<HTMLElement> {
  const { default: WorkerPage } = await import('@/app/worker/page');
  return render(await WorkerPage()).container;
}

describe('the worker page', () => {
  it('heads with its title and gives its status as an answer box, with what it is doing now', async () => {
    const c = await draw();
    expect(c.querySelector('h1')?.textContent).toBe('Worker');
    const answer = [...c.querySelectorAll('p')].find((p) => p.textContent === 'Nothing has failed.')!;
    expect(answer).toBeTruthy();
    expect([...c.querySelectorAll('h2')].some((h) => h.textContent === 'Nothing has failed.')).toBe(false);
    expect(answer.closest('.rounded-lg')?.textContent).toContain('Now Idle between passes.');
  });

  it('counts what needs a person, each as an alert with what to do, and lists the rest under it', async () => {
    state.notices = [
      { severity: 'needs-you', text: 'fund has never run.', doThis: 'Check the worker is running', href: '/worker' },
      { severity: 'info', text: 'No Etherscan key.' },
    ];
    const c = await draw();
    expect(c.textContent).toContain('1 thing needs you');
    expect(c.querySelector('[role=alert]')?.textContent).toBe('fund has never run.Do this: Check the worker is running');
    expect(c.textContent).toContain('No Etherscan key.');
  });

  it('spans each job card over shared rows, so its figures line up with its neighbours', async () => {
    const cards = [...(await draw()).querySelectorAll('ol > li')];
    expect(cards).toHaveLength(4);
    for (const li of cards) expect(li.className).toContain('lg:grid-rows-subgrid');
  });
});
