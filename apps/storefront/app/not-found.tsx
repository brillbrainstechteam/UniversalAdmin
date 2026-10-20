'use client';

import { EmptyState, LoadingState } from '@uc/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { shopApi } from '../lib/shop';

/** Unknown path: follow the merchant's redirect if one exists, otherwise say so. */
export default function NotFound() {
  const pathname = usePathname();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    shopApi<{ toPath: string }>('/redirects', { query: { path: pathname } })
      .then((r) => (r.toPath.startsWith('/') ? router.replace(r.toPath) : window.location.replace(r.toPath)))
      .catch(() => setChecked(true));
  }, [pathname, router]);
  if (!checked) return <LoadingState />;
  return (
    <>
      <EmptyState title="Page not found" description="The page you are looking for is not here." />
      <Link href="/">Back to the shop</Link>
    </>
  );
}
