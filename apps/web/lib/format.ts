/** Display only. Nothing here is summed or compared; amounts stay wei strings until they are drawn. */

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Wei to a readable native amount, to four significant places past the point. */
export function eth(wei: string | null, unit = 'ETH'): string {
  if (wei === null) return '—';
  const n = BigInt(wei);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? `.${frac}` : ''} ${unit}`;
}

/** A share as a percentage: never "0%" for a share above zero, which would read as clean. */
export function pct(part: number, whole: number): string {
  if (whole === 0) return '—';
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
}

/** Clock times, never "ago": a reading compared across tabs must say when, not how long before some other moment. */
export function clock(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const day = d.toISOString().slice(0, 10);
  return `${day} ${d.toISOString().slice(11, 16)} UTC`;
}

export function blockTime(seconds: number | null): string {
  return seconds === null ? '—' : clock(seconds * 1000);
}

export const METHOD_NAMES = {
  A: 'SCC A',
  AU: 'SCC AU',
  AC: 'SCC AC',
} as const;

export const METHOD_SENTENCES = {
  A: 'Cycles in the token’s own transfer history: wallets passing the token back and forth.',
  AU: 'Cycles closed by money: the token moves one way and payment finds its way back, up to 30 wallets deep.',
  AC: 'SCC A, plus any two trading wallets joined by money within two hops, in either direction.',
} as const;

export function explorer(chainId: number): string {
  const hosts: Record<number, string> = {
    1: 'https://etherscan.io', 10: 'https://optimistic.etherscan.io', 137: 'https://polygonscan.com',
    8453: 'https://basescan.org', 42161: 'https://arbiscan.io', 81457: 'https://blastscan.io', 33139: 'https://apescan.io',
  };
  return hosts[chainId] ?? 'https://etherscan.io';
}
