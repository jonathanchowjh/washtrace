import Link from 'next/link';
import { Head } from '@/components/ui';

/**
 * A token, wallet, ring or trade a watched collection does not hold. It sits
 * under the collection's tabs, which name the collection, so the root page's
 * "not watched" is never said of one that is.
 */
export default function NotInCollection() {
  return (
    <>
      <Head title="Not found" />
      <div className="rounded-lg border bg-card p-4 text-sm sm:p-5">
        <p className="text-foreground">Nothing in this collection&apos;s reading has that number, address or hash.</p>
        <p className="mt-3"><Link href="/" className="underline">Back to Collections</Link></p>
      </div>
    </>
  );
}
