import type { Parsed, SearchHits, SearchKind } from '@washtrace/detect';
import { chainName } from './chains';
import { plural, short } from './format';
import { MAX_TEXT, pageOf, tokenIdOf } from './params';

/**
 * Reading what was typed into search, and the page and kind a results URL
 * asks for. The sidebar loads this file, so it takes its rules from the
 * import-free lib/params.ts: lib/api.ts value-imports detect's main entry,
 * which a client component must not.
 */

export type { Parsed, SearchKind };

/** Rows per kind on the results page, and per page of one kind. */
export const SEARCH_LIMIT = 20;

export const SEARCH_KINDS: readonly SearchKind[] = ['collections', 'tokens', 'wallets', 'trades'];

/**
 * Trims, lowercases hex and strips one leading '#'. One or two bare digits are
 * text, so typing "12" never searches every collection's tokens; "#12" does.
 * findOf in packages/detect/src/trades.ts is its twin for a Trades Find box:
 * a change to one is made to both.
 */
export function parseSearch(raw: string): Parsed {
  const typed = raw.trim();
  const hashed = typed.startsWith('#');
  const text = (hashed ? typed.slice(1) : typed).trim();
  if (/^0x[0-9a-f]+$/i.test(text) && !hashed) {
    const hex = text.toLowerCase();
    if (hex.length === 66) return { kind: 'tx', tx: hex };
    if (hex.length === 42) return { kind: 'address', address: hex };
    if (hex.length >= 6 && hex.length < 42) return { kind: 'prefix', prefix: hex };
  }
  const tokenId = tokenIdOf(text);
  if (tokenId !== null && (hashed || text.length >= 3)) return { kind: 'token', tokenId, text };
  if (text.length < 2) return { kind: 'empty' };
  return { kind: 'text', text: text.slice(0, MAX_TEXT) };
}

/**
 * The kind and page of a results URL; anything else is dropped or clamped.
 * A page means something only beside a kind, and only a whole number a
 * database offset can hold, so a stray or huge one reads as the first.
 */
export function searchArgs(q: { kind?: string; page?: string }): { only: SearchKind | undefined; page: number } {
  const only = SEARCH_KINDS.find((k) => k === q.kind);
  const page = pageOf(q.page);
  return { only, page: only && page <= 1_000_000 ? page : 1 };
}

/**
 * One hit as a link: where it opens, the line that says what it is, and its
 * address. The results page and the search box's list both draw this, so a hit
 * reads the same in both.
 */
export function hitRow(hits: SearchHits, kind: SearchKind, i: number): { href: string; line: string; address: string } {
  if (kind === 'collections') {
    const h = hits.collections[i]!;
    return { href: `/c/${h.chainId}/${h.address}`, line: `Collection on ${chainName(h.chainId)} · ${h.name ?? h.symbol ?? short(h.address)}`, address: h.address };
  }
  if (kind === 'tokens') {
    const h = hits.tokens[i]!;
    return { href: `/c/${h.chainId}/${h.address}/t/${h.tokenId}`, line: `Token #${h.tokenId} in ${h.name ?? short(h.address)} · ${plural(h.transfers, 'transfer')}`, address: h.address };
  }
  if (kind === 'wallets') {
    const h = hits.wallets[i]!;
    return { href: `/w/${h.chainId}/${h.address}`, line: `Wallet on ${chainName(h.chainId)} · in ${plural(h.transfers, 'transfer')} of watched collections`, address: h.address };
  }
  const h = hits.trades[i]!;
  return { href: `/tx/${h.chainId}/${h.txHash}`, line: `Trade in ${h.name ?? short(h.address)}, token #${h.tokenId}`, address: h.address };
}
