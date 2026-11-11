import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Notice } from '@/lib/status';

const state = { notices: [] as Notice[], rpc: [1] };
const job = (j: string) => ({ job: j, state: 'ok', startedAt: null, finishedAt: null, tookMs: null, outcome: null, detail: null });
vi.mock('@/lib/views', () => ({
  workerView: async () => ({
    every: { ingest: 60_000, fund: 60_000, analyze: 60_000, lens: 60_000 }, rpcChains: state.rpc, funding: null, followHops: null, trailFunded: false,
    passes: [], jobs: ['ingest', 'fund', 'analyze', 'lens'].map(job), notices: state.notices, backlog: [], collections: [],
  }),
}));
vi.mock('@/lib/api', () => ({ readerZone: async () => 'UTC' }));
vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => { cleanup(); state.notices = []; state.rpc = [1]; });

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

  // What the Notices tests held, now that the status is drawn here alone.
  it('links a Do this that has a place to go, says one that has none as text, and counts two as two', async () => {
    state.notices = [
      { severity: 'needs-you', text: 'Etherscan rejected the key.', doThis: 'Open Settings', href: '/settings' },
      { severity: 'needs-you', text: 'fund has never run.', doThis: 'Check the worker is running' },
      { severity: 'working', text: 'Checking wallets for Terraforms: 1,612 of 11,259' },
      { severity: 'info', text: 'No Etherscan key.', action: { label: 'How to turn it on', href: '/worker#sources' } },
    ];
    const c = await draw();
    expect(c.textContent).toContain('2 things need you');
    const alerts = [...c.querySelectorAll('[role=alert]')];
    expect(alerts.map((a) => a.querySelector('a')?.getAttribute('href') ?? null)).toEqual(['/settings', null]);
    // A working or info notice has no Do this line, and an info one keeps its action link.
    expect(c.textContent?.match(/Do this:/g)).toHaveLength(2);
    expect([...c.querySelectorAll('a')].find((a) => a.textContent === 'How to turn it on')?.getAttribute('href')).toBe('/worker#sources');
  });

  it('sends the chain RPC to Settings, saying change only where Settings can change every one', async () => {
    const link = (c: Element) => [...c.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/settings#rpc')!;
    expect(link(await draw()).textContent).toBe('change in Settings');
    cleanup();
    state.rpc = [1, 31337];
    const c = await draw();
    expect(c.textContent).toContain('Ethereum, Local (anvil) · where each comes from, in Settings');
    expect(link(c).textContent).toBe('where each comes from, in Settings');
  });

  it('numbers no job, so a job is never read as the reading stage of the same number', async () => {
    const c = await draw();
    const titles = [...c.querySelectorAll('ol[aria-label="Jobs"] > li p.font-medium')].map((p) => p.textContent);
    expect(titles).toEqual(['Read transfers', 'Check wallets for money', 'Run the built-in lenses', 'Run your lenses']);
    expect(c.textContent).toContain('They are not the reading stages below');
  });

  it('spans each job card over shared rows, so its figures line up with its neighbours', async () => {
    const cards = [...(await draw()).querySelectorAll('ol > li')];
    expect(cards).toHaveLength(4);
    for (const li of cards) expect(li.className).toContain('lg:grid-rows-subgrid');
  });
});
