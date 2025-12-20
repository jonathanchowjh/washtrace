import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { messageOf } from '@washtrace/detect';
import { Head, Problem } from '@/components/head';
import { Settings } from '@/components/settings';
import { settingsView } from '@/lib/views';

export const metadata: Metadata = { title: 'Settings' };

/** Where the worker reads from and how hard, as /api/settings answers it: the page never shows what the API would not say. */
export default async function SettingsPage() {
  await connection();
  let v: Awaited<ReturnType<typeof settingsView>>;
  try {
    v = await settingsView();
  } catch (err) {
    return <><Head title="Settings" /><Problem title="The store did not answer">{messageOf(err)}</Problem></>;
  }
  return (
    <>
      <Head title="Settings" sub={<>Where the <Link href="/worker" className="underline">worker</Link> reads from, and how hard. A change applies from its next pass, within a minute, with no restart. A value set in the worker&apos;s environment wins.</>} />
      <Settings fields={v.fields} writable={v.writable} />
    </>
  );
}
