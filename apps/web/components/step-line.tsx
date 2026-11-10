import { collectionOf, itemId, type Item } from '@/lib/collection-reads';
import { fromOf, stepOf } from '@/lib/step';
import { Stepper } from './stepper';

/**
 * The stepper for an item, read from the `from` its URL carries: a page puts
 * it in a Suspense of its own, so reading the list never holds the item back.
 * Nothing without a `from`, or when the item has left that page of its list.
 */
export async function StepLine({ chainId, address, from, of }: { chainId: number; address: string; from: string | string[] | undefined; of: Item }) {
  const list = fromOf(from);
  if (list === null) return null;
  const c = await collectionOf(chainId, address);
  if (!c) return null;
  const step = await stepOf(c, list, itemId(of)).catch(() => null);
  return step === null ? null : <Stepper step={step} />;
}
