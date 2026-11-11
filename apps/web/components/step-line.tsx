import { collectionOf, itemId, type Item } from '@/lib/collection-reads';
import { listHref } from '@/lib/links';
import { fromOf, stepOf } from '@/lib/step';
import { tradesHref } from '@/lib/trades-url';
import { BackLine, Stepper } from './stepper';

/** The list tab an item belongs to, under the lens it was opened with: where its way back goes with no list to step through. */
function listOf(base: string, of: Item, method: string | undefined): { href: string; label: string } {
  const tab = (kind: 'tokens' | 'wallets') => ({ href: method === undefined ? `${base}/${kind}` : listHref(base, kind, { method }), label: `All ${kind}` });
  return 'token' in of ? tab('tokens') : 'wallet' in of ? tab('wallets')
    : 'ring' in of ? { href: `${base}/rings`, label: 'All rings' } : { href: tradesHref(base, {}), label: 'All trades' };
}

/** Whether a list of this kind can hold the item: a `from` of another kind costs no read. A ring's own members are a list of both. */
function listsIt(kind: NonNullable<ReturnType<typeof fromOf>>['kind'], of: Item): boolean {
  return kind === ('token' in of ? 'tokens' : 'wallet' in of ? 'wallets' : 'ring' in of ? 'rings' : 'trades') || (kind === 'ring' && ('token' in of || 'wallet' in of));
}

/**
 * The stepper for an item, read from the `from` its URL carries: a page puts
 * it in a Suspense of its own, so reading the list never holds the item back.
 * With no `from`, or when the item has left that page of its list, only the
 * way back, to the item's list tab under the lens it was opened with.
 */
export async function StepLine({ chainId, address, from, method, of }: { chainId: number; address: string; from: string | string[] | undefined; method?: string; of: Item }) {
  const back = <BackLine back={listOf(`/c/${chainId}/${address}`, of, method)} />;
  const list = fromOf(from);
  if (list === null || !listsIt(list.kind, of)) return back;
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  const step = await stepOf(c, list, itemId(of)).catch(() => null);
  return step === null ? back : <Stepper step={step} />;
}
