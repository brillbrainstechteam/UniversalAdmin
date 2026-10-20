import type { PlanUsage, UsageLine } from '@uc/contracts';
import { Badge, formatDateTime } from './components';

/** Phase 12: plan usage table shared by the merchant admin and the platform console. */
const STATE_TONE: Record<UsageLine['state'], 'success' | 'warning' | 'danger' | 'info' | undefined> = {
  ok: 'success',
  near: 'warning',
  at: 'warning',
  over: 'danger',
  unlimited: 'info',
};

export function UsageTable({ usage, timeZone }: { usage: PlanUsage; timeZone: string }) {
  return (
    <>
      <table className="uc-table">
        <caption className="uc-sr-only">Plan usage</caption>
        <thead>
          <tr>
            <th scope="col">Limit</th>
            <th scope="col">Used</th>
            <th scope="col">Allowed</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {usage.usage.map((l) => (
            <tr key={l.key}>
              <td>
                {l.label}
                {!l.hard && (
                  <div className="uc-muted">Soft limit: shown as a warning, never blocks a sale.</div>
                )}
              </td>
              <td>{l.used}</td>
              <td>{l.limit ?? 'Unlimited'}</td>
              <td>
                <Badge tone={STATE_TONE[l.state]}>{l.state === 'at' ? 'limit reached' : l.state}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="uc-muted">
        Counted live at {formatDateTime(usage.generatedAt, timeZone)}. The month started{' '}
        {formatDateTime(usage.monthStart, timeZone)}. Billing is not connected: plans carry no charges yet.
      </p>
    </>
  );
}
