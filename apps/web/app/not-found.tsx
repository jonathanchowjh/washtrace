import Link from 'next/link';
import { Head } from '@/components/head';

export default function NotFound() {
  return (
    <>
      <Head title="Not found" />
      <p className="mt-4">Nothing is watched at this address. <Link href="/" className="underline">Back to collections</Link>, or watch it from there.</p>
    </>
  );
}
