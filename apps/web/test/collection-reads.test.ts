import { describe, expect, it, vi } from 'vitest';

const ADDR = '0x' + 'ab'.repeat(20);
const row = { id: 3, chainId: 1, address: ADDR };
const fake = { collection: vi.fn(async (chainId: number, address: string) => (chainId === 1 && address === ADDR ? row : null)) };
vi.mock('@/lib/store', () => ({ store: () => fake }));

const { collectionAt } = await import('@/lib/collection-reads');

describe('collectionAt', () => {
  it('returns the row of a watched collection, reading the address lowercased', async () => {
    expect(await collectionAt({ chain: '1', address: '0x' + 'AB'.repeat(20) })).toBe(row);
    expect(fake.collection).toHaveBeenCalledWith(1, ADDR);
  });

  it('is null for a chain that is not a number, without a read', async () => {
    fake.collection.mockClear();
    expect(await collectionAt({ chain: 'eth', address: ADDR })).toBeNull();
    expect(fake.collection).not.toHaveBeenCalled();
  });

  it('is null for a malformed address, without a read', async () => {
    fake.collection.mockClear();
    expect(await collectionAt({ chain: '1', address: '0x1234' })).toBeNull();
    expect(fake.collection).not.toHaveBeenCalled();
  });

  it('is null for a collection that is not watched', async () => {
    expect(await collectionAt({ chain: '2', address: ADDR })).toBeNull();
  });
});
