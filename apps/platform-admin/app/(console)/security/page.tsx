'use client';

import { MfaSettings, PageHeader } from '@uc/ui';

export default function PlatformSecurityPage() {
  return (
    <>
      <PageHeader
        title="My security"
        description="Platform operators should keep two-step verification on: your account can reach every merchant."
      />
      <MfaSettings />
    </>
  );
}
