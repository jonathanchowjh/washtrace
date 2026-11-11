import type { Metadata } from 'next';
import { FlaggedView, metadataOf } from '../list-view';

type Props = Omit<Parameters<typeof FlaggedView>[0], 'kind'>;

export const generateMetadata = (props: Props): Promise<Metadata> => metadataOf('wallets', props);

/** Every wallet one lens flags in the collection, a page at a time, most flagged first. */
export default function WalletsPage(props: Props) {
  return FlaggedView({ kind: 'wallets', ...props });
}
