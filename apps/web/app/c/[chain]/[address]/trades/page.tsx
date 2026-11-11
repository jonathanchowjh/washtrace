import type { Metadata } from 'next';
import { FlaggedView, metadataOf } from '../list-view';

type Props = Omit<Parameters<typeof FlaggedView>[0], 'kind'>;

export const generateMetadata = (props: Props): Promise<Metadata> => metadataOf('trades', props);

/** The collection's trades under any filters, every one of them in the address bar. */
export default function TradesPage(props: Props) {
  return FlaggedView({ kind: 'trades', ...props });
}
