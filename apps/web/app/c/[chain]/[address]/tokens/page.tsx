import type { Metadata } from 'next';
import { FlaggedView, metadataOf } from '../flagged/view';

type Props = Omit<Parameters<typeof FlaggedView>[0], 'kind'>;

export const generateMetadata = (props: Props): Promise<Metadata> => metadataOf('tokens', props);

/** Every token one lens flags in the collection, a page at a time, most flagged first. */
export default function TokensPage(props: Props) {
  return FlaggedView({ kind: 'tokens', ...props });
}
