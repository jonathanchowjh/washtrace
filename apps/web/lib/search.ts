import type { Parsed, SearchHits, SearchKind } from '@washtrace/detect';
import { chainName } from './chains';
import { plural, short, tokenLabel } from './format';
import { txHref, walletHref } from './links';
import { MAX_TEXT, addressOf, chainOf, pageOf, tokenIdOf } from './params';

/**
 * Reading what was typed into search, and the page and kind a results URL
 * asks for. The sidebar loads this file, so it takes its rules from the
 * import-free lib/params.ts: lib/api.ts value-imports detect's main entry,
 * which a client component must not.
 */

/** Rows per kind on the results page, and per page of one kind. */
export const SEARCH_LIMIT = 20;

const SEARCH_KINDS: readonly SearchKind[] = ['collections', 'tokens', 'wallets', 'trades'];

/** A search narrowed to one collection, as `scope=<chain>:<address>` carries it. */
export type Scope = { chainId: number; address: string };

/** The collection a `scope` parameter names, or null for anything else. */
export function scopeOf(raw: string | null | undefined): Scope | null {
  const [chain, address, rest] = (raw ?? '').split(':');
  const chainId = chainOf(chain ?? '');
  const a = addressOf(address ?? '');
  return rest === undefined && chainId !== null && a !== null ? { chainId, address: a } : null;
}

export const scopeParam = (s: Scope) => `${s.chainId}:${s.address}`;

/** The collection a console path is under, which its search box narrows to. */
export function scopeOfPath(path: string): Scope | null {
  const m = /^\/c\/([^/]+)\/([^/]+)/.exec(path);
  return m === null ? null : scopeOf(`${m[1]}:${m[2]}`);
}

/**
 * The kinds in the order a search reads best: the kind of thing typed first,
 * so a token number leads with tokens and a hash with its trades, then the rest.
 */
export function kindsFor(p: Parsed): readonly SearchKind[] {
  const first: SearchKind | null = p.kind === 'token' ? 'tokens' : p.kind === 'tx' ? 'trades' : p.kind === 'prefix' ? 'wallets' : null;
  return first === null ? SEARCH_KINDS : [first, ...SEARCH_KINDS.filter((k) => k !== first)];
}

/** The kind of a search's best match: the first kind, in kindsFor's order, with any hit. Its first hit is the match. */
export function bestKind(hits: SearchHits, p: Parsed): SearchKind | undefined {
  return kindsFor(p).find((k) => hits[k].length > 0);
}

/** Rings and tokens listed under a scoped search's best match: a few, each one Enter away. */
export const CONNECTED = 3;

/** What a scoped search's best match is connected to in that collection, when it is a wallet: its rings by rank, and the tokens it traded most. */
export type Connected = { wallet: string; rings: { anchor: string; rank: number }[]; tokens: string[] };

/** What /api/search answers: the hits and, for a scoped search whose best match is a wallet, what it is connected to there. */
export type SearchReply = SearchHits & { connected?: Connected };

/** Hex after `0x` before a start of an address is searched: fewer would match most of them. */
const PREFIX_HEX = 4;
/** Digits before a bare number is read as a token in every collection; a '#' reads fewer. */
const TOKEN_DIGITS = 3;

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
    if (hex.length >= 2 + PREFIX_HEX && hex.length < 42) return { kind: 'prefix', prefix: hex };
  }
  const tokenId = tokenIdOf(text);
  if (tokenId !== null && (hashed || text.length >= TOKEN_DIGITS)) return { kind: 'token', tokenId, text };
  if (text.length < 2) return { kind: 'empty' };
  return { kind: 'text', text: text.slice(0, MAX_TEXT) };
}

/**
 * Why a search that found nothing may have missed what was meant: it was too
 * short for parseSearch to read as the start of an address or as a token
 * number, so only names were searched. Null when it was read in full, and
 * "no match" is the whole story.
 */
export function tooShort(raw: string): string | null {
  const typed = raw.trim();
  if (new RegExp(`^0x[0-9a-f]{0,${PREFIX_HEX - 1}}$`, 'i').test(typed)) return `Too short to search wallets and transactions: type at least ${PREFIX_HEX} characters after 0x.`;
  if (new RegExp(`^\\d{1,${TOKEN_DIGITS - 1}}$`).test(typed)) return `Too short for a token number: type ${TOKEN_DIGITS} digits, or #${typed}.`;
  return null;
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
 * Where a trade hit opens: under its collection's tabs when every transfer of
 * its transaction found is in that collection and none were cut off, else the
 * transaction's own page, as the page under a collection requires.
 */
export function tradeHref(hits: SearchHits, h: SearchHits['trades'][number]): string {
  const one = !hits.more.trades && hits.trades.every((o) => o.txHash !== h.txHash || o.address === h.address);
  return txHref(h.chainId, h.txHash, one ? `/c/${h.chainId}/${h.address}` : null);
}

/** One hit as a link: where it opens, what names it, whether that name is hex (an address or hash), and what kind of thing it is, on which chain. */
export type HitRow = { href: string; title: string; hex: boolean; detail: string };

/**
 * One hit as a link, led by what was searched for: a collection's name, a
 * token's number, a wallet's address, a transaction's hash. The kind and the
 * chain follow, smaller. The results page and the search box's list both draw
 * this, so a hit reads the same in both. `scope` keeps a wallet hit under that
 * collection's tabs, where the search was made.
 */
export function hitRow(hits: SearchHits, kind: SearchKind, i: number, scope: Scope | null = null): HitRow {
  if (kind === 'collections') {
    const h = hits.collections[i]!;
    const name = h.name ?? h.symbol;
    return { href: `/c/${h.chainId}/${h.address}`, title: name ?? short(h.address), hex: name === null, detail: `Collection on ${chainName(h.chainId)} · ${short(h.address)}` };
  }
  if (kind === 'tokens') {
    const h = hits.tokens[i]!;
    return { href: `/c/${h.chainId}/${h.address}/t/${h.tokenId}`, title: `${h.name ?? short(h.address)} #${tokenLabel(h.tokenId)}`, hex: false, detail: `Token on ${chainName(h.chainId)} · ${plural(h.transfers, 'transfer')}` };
  }
  if (kind === 'wallets') {
    const h = hits.wallets[i]!;
    // A full address is found wherever it traded: one that never traded in the scope opens on its own page.
    const within = scope !== null && scope.chainId === h.chainId && h.here !== false ? `/c/${scope.chainId}/${scope.address}` : null;
    return { href: walletHref(h.chainId, h.address, within), title: short(h.address), hex: true, detail: `Wallet on ${chainName(h.chainId)} · in ${plural(h.transfers, 'transfer')} of watched collections` };
  }
  const h = hits.trades[i]!;
  return { href: tradeHref(hits, h), title: short(h.txHash), hex: true, detail: `Trade on ${chainName(h.chainId)} · ${h.name ?? short(h.address)} #${tokenLabel(h.tokenId)}` };
}
