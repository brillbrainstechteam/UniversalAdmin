'use client';

import { PageHeader } from '@uc/ui';
import { SetupChecklistCard } from '../../../../lib/launch';

export default function SetupPage() {
  return (
    <>
      <PageHeader
        title="Setup guide"
        description="Each step is checked against your real records, so it completes itself as you set things up."
      />
      <SetupChecklistCard />
    </>
  );
}
