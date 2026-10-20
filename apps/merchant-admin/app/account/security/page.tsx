'use client';

import { MfaSettings, PageHeader } from '@uc/ui';
import Link from 'next/link';

/** Personal account security (outside any merchant, so a merchant's MFA requirement cannot lock it). */
export default function AccountSecurityPage() {
  return (
    <main className="uc-content" style={{ maxWidth: 720, margin: '0 auto' }}>
      <PageHeader
        title="Account security"
        description="Two-step verification protects your sign-in to every merchant you work for."
      />
      <MfaSettings />
      <p>
        <Link href="/">Back to your merchants</Link>
      </p>
    </main>
  );
}
