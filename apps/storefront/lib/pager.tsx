'use client';

import { Button } from '@uc/ui';

export function Pager(p: {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  page: number;
}) {
  if (!p.hasPrev && !p.hasNext) return null;
  return (
    <nav className="uc-pagination" aria-label="Pages">
      <Button size="sm" onClick={p.onPrev} disabled={!p.hasPrev}>
        Previous
      </Button>
      <span className="uc-muted">Page {p.page}</span>
      <Button size="sm" onClick={p.onNext} disabled={!p.hasNext}>
        Next
      </Button>
    </nav>
  );
}
