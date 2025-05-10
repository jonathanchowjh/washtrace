import type { Flow, Transfer } from '../src/types.js';
import { ZERO } from '../src/graph.js';
import type { Input } from '../src/methods.js';

/** Readable stand-ins for addresses: `w('a')` is a wallet named a. */
export function w(name: string): string {
  return `0x${name.padStart(40, '0')}`;
}

let seq = 0;

/** A transfer of `tokenId` from `from` to `to`, each in its own block unless one is given. */
export function transfer(tokenId: string, from: string, to: string, more: Partial<Transfer> = {}): Transfer {
  seq += 1;
  return {
    txHash: `0xtx${seq}`, logIndex: 0, blockNumber: seq, blockTime: null, tokenId, from, to,
    marketplace: null, priceWei: null, currency: null, ...more,
  };
}

/** A token's life as a chain of holders: mint to the first, then each to the next. */
export function chain(tokenId: string, ...holders: string[]): Transfer[] {
  const out = [transfer(tokenId, ZERO, holders[0]!)];
  for (let i = 1; i < holders.length; i++) out.push(transfer(tokenId, holders[i - 1]!, holders[i]!));
  return out;
}

export function flow(from: string, to: string, more: Partial<Flow> = {}): Flow {
  seq += 1;
  return { txHash: `0xflow${seq}`, kind: 'native', from, to, valueWei: '1000', token: '', blockNumber: seq, blockTime: seq, ...more };
}

export function input(transfers: Transfer[], flows: Flow[] = [], more: Partial<Input> = {}): Input {
  const wallets = new Set(transfers.flatMap((t) => [t.from, t.to]));
  return {
    transfers, flows, fundingAvailable: true, funded: wallets, truncated: new Set(),
    custodians: new Set(), contracts: new Set(), money: new Set(['']), ...more,
  };
}
