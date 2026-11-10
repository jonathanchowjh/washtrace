import type { CollectionRow } from '@washtrace/detect';
import { fromOf, stepOf } from '@/lib/step';
import { Stepper } from './stepper';

/**
 * The stepper for an item, read from the `from` its URL carries: a page puts
 * it in a Suspense of its own, so reading the list never holds the item back.
 * Nothing without a `from`, or when the item has left that page of its list.
 */
export async function StepLine({ c, from, id }: { c: CollectionRow; from: string | string[] | undefined; id: string }) {
  const list = fromOf(from);
  if (list === null) return null;
  const step = await stepOf(c, list, id).catch(() => null);
  return step === null ? null : <Stepper step={step} />;
}
