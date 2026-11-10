/**
 * Rings: the wallets the counted evidence joins. Two witnesses that share a
 * wallet are one ring, so a ring is every wallet a chain of loops and linked
 * pairs ties together, middles included. It is not a fourth method and flags
 * nothing: it groups what Round trips and Linked wallets already caught, so
 * a reader can see who acted together. Money loops back is left out by the
 * caller, as it is out of every count.
 *
 * Each ring is named by its anchor, the smallest wallet address in it: an
 * analysis renumbers witnesses, but a ring with the same wallets keeps its
 * anchor, so a link to it survives.
 *
 * Returns each witness's anchor, by witness id. A witness with no wallets is in
 * no ring.
 */
export function ringsOf(witnesses: Iterable<{ id: number; wallets: readonly string[] }>): Map<number, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Halve the next walk: every wallet on this one points at the root.
    for (let y = x; y !== root;) { const next = parent.get(y)!; parent.set(y, root); y = next; }
    return root;
  };
  // The smaller root wins, so a ring's root is always its smallest wallet: its anchor.
  const join = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const list = [...witnesses].filter((w) => w.wallets.length > 0);
  for (const w of list) for (const a of w.wallets) if (!parent.has(a)) parent.set(a, a);
  for (const w of list) for (let i = 1; i < w.wallets.length; i++) join(w.wallets[0]!, w.wallets[i]!);
  return new Map(list.map((w) => [w.id, find(w.wallets[0]!)]));
}
