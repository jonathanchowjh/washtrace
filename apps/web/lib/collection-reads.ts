import { cache } from 'react';
import { moneyFor, type CollectionRow } from '@washtrace/detect';
import type { TradeQuery } from '@washtrace/detect/trades';
import { readerZone } from './api';
import { lensContext } from './metrics';
import { addressOf, chainOf } from './params';
import { store } from './store';

/**
 * A collection and your lenses' runs on it, read once per request: its layout
 * (the tab bar) and the page under it, and a page's tab title, all need them.
 */
export const collectionOf = cache((chainId: number, address: string) => store().collection(chainId, address));

/** The rows of a stored payment, read once per request: a transaction's page and its tab title both ask. Null when none is stored. */
export const paymentOf = cache((chainId: number, tx: string) => store().payment(chainId, tx));

/** A transaction's transfers, read once per request: the verdict, the page and a tab title all ask. */
export const transactionOf = cache((chainId: number, tx: string) => store().transaction(chainId, tx));

/** Whether a transaction moves a token of the collection at `address`: the one test of whether its page there is a sale's. */
export function movesIn(transfers: readonly { collection?: { address: string } | null }[], address: string): boolean {
  return transfers.some((t) => t.collection?.address === address);
}

/** The collection a page's path names, through the same cached read: null for a bad chain, a bad address or a collection not watched. */
export async function collectionAt(p: { chain: string; address: string }) {
  const chainId = chainOf(p.chain);
  const address = addressOf(p.address);
  return chainId === null || address === null ? null : await collectionOf(chainId, address);
}

/** The chains the watched collections are on, each once: where an address nothing holds is looked for. None when the store cannot say. */
export async function watchedChains(): Promise<number[]> {
  try {
    return [...new Set((await store().collections()).map((c) => c.chainId))];
  } catch {
    return [];
  }
}

export const runsOf = cache((collectionId: number) => store().lensRuns(collectionId));

/**
 * What a page's trade reads of a collection take: the chain's money, the
 * reader's zone, and the lenses that ran there. Once per request, for `c` as
 * collectionOf read it. A route answers in a zone it is given, so it builds its own.
 */
export const tradeContextOf = cache(async (c: CollectionRow) => ({ money: moneyFor(c.chainId), zone: await readerZone(), ...lensContext(c.latest, await runsOf(c.id)) }));

/**
 * One item of a collection, as every panel about it is told which: the
 * stepper, the ring chips, the strip and Connected to.
 */
export type Item = { wallet: string } | { token: string } | { tx: string } | { ring: string };

/** Its id, as a list finds it: a wallet's address, a token's number, a transaction's hash, a ring's anchor. */
export function itemId(of: Item): string {
  return 'wallet' in of ? of.wallet : 'token' in of ? of.token : 'tx' in of ? of.tx : of.ring;
}

/** Its trades, as the Trades tab filters them: a transaction's by its hash. */
export function tradesOf(of: Item): Partial<Pick<TradeQuery, 'wallet' | 'token' | 'ring' | 'find'>> {
  return 'tx' in of ? { find: of.tx } : of;
}

/** "this wallet's", as the strip names an item's own sales. */
export function whose(of: Item): string {
  return `this ${'wallet' in of ? 'wallet' : 'token' in of ? 'token' : 'tx' in of ? 'trade' : 'ring'}'s`;
}
