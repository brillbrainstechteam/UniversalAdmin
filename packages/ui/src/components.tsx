'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { ApiError } from './api';

// ---------------------------------------------------------------- primitives

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  loading?: boolean;
};

export function Button({
  variant = 'default',
  size = 'md',
  loading,
  disabled,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className="uc-btn"
      data-variant={variant}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? 'Working…' : children}
    </button>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone?: 'success' | 'danger' | 'warning' | 'info';
  children: ReactNode;
}) {
  return (
    <span className="uc-badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active' || status === 'verified' || status === 'accepted'
      ? 'success'
      : status === 'suspended' || status === 'revoked' || status === 'dead'
        ? 'danger'
        : status === 'pending' || status === 'provisioning' || status === 'expired'
          ? 'warning'
          : undefined;
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>;
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="uc-card">
      {(title || actions) && (
        <div className="uc-card-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="uc-row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="uc-page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="uc-row">{actions}</div>}
    </header>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'danger' | 'success' | 'warning';
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="uc-alert" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      {title && <strong style={{ display: 'block' }}>{title}</strong>}
      {children && (typeof children === 'string' ? <p>{children}</p> : children)}
    </div>
  );
}

// ---------------------------------------------------------------- form fields

interface FieldShell {
  label: string;
  error?: string;
  hint?: ReactNode;
}

export function TextField({
  label,
  error,
  hint,
  id,
  ...rest
}: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="uc-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="uc-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-err` : hint ? `${inputId}-hint` : undefined}
        {...rest}
      />
      {hint && !error && (
        <span id={`${inputId}-hint`} className="uc-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${inputId}-err`} className="uc-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function SelectField({
  label,
  error,
  hint,
  id,
  options,
  hideLabel,
  ...rest
}: FieldShell &
  SelectHTMLAttributes<HTMLSelectElement> & {
    options: { value: string; label: string }[];
    /** Keep the label for screen readers only (e.g. inside a table row with a column header). */
    hideLabel?: boolean;
  }) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className="uc-field">
      <label htmlFor={selectId} className={hideLabel ? 'uc-sr-only' : undefined}>
        {label}
      </label>
      <select
        id={selectId}
        className="uc-select"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${selectId}-err` : undefined}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && !error && <span className="uc-hint">{hint}</span>}
      {error && (
        <span id={`${selectId}-err`} className="uc-error">
          {error}
        </span>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  description,
  ...rest
}: { label: string; description?: string } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="uc-checkbox">
      <input type="checkbox" id={id} {...rest} />
      <label htmlFor={id}>
        {label}
        {description && <span className="uc-muted"> — {description}</span>}
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- states

export function LoadingState({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="uc-stack" role="status" aria-live="polite">
      <span className="uc-sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="uc-skeleton" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="uc-state">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;
  if (apiError && (apiError.code === 'PERMISSION_DENIED' || apiError.code === 'FORBIDDEN')) {
    return <ForbiddenState message={apiError.message} />;
  }
  return (
    <div className="uc-state" role="alert">
      <h3>Something went wrong</h3>
      <p>{error instanceof Error ? error.message : 'Unexpected error'}</p>
      {apiError?.correlationId && <p className="uc-mono">Reference: {apiError.correlationId}</p>}
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function ForbiddenState({ message }: { message?: string }) {
  return (
    <div className="uc-state" role="alert">
      <h3>You don’t have access to this page</h3>
      <p>{message ?? 'Ask an owner or administrator to grant you the required permission.'}</p>
    </div>
  );
}

// ---------------------------------------------------------------- dialog

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="uc-dialog" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      <div className="uc-dialog-body">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
      {footer && <div className="uc-dialog-footer">{footer}</div>}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'danger',
  requireReason,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  requireReason?: boolean;
  loading?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const tooShort = requireReason && reason.trim().length < 5;
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={tone}
            loading={loading}
            disabled={tooShort}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div>{description}</div>
      {requireReason && (
        <TextField
          label="Reason (recorded in the audit log)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="At least 5 characters"
          required
        />
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- table + pagination

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  isLoading,
  error,
  onRetry,
  empty,
  pagination,
}: {
  caption: string;
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty: ReactNode;
  pagination?: { hasPrev: boolean; hasNext: boolean; onPrev: () => void; onNext: () => void; page: number };
}) {
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (isLoading || !rows) return <LoadingState rows={5} />;
  if (rows.length === 0 && !pagination?.hasPrev) return <>{empty}</>;
  return (
    <div className="uc-stack">
      <div className="uc-table-wrap">
        <table className="uc-table">
          <caption className="uc-sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => (
                  <td key={c.key}>{c.render(row)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pagination && (pagination.hasPrev || pagination.hasNext) && (
        <nav className="uc-pagination" aria-label={`${caption} pagination`}>
          <Button size="sm" onClick={pagination.onPrev} disabled={!pagination.hasPrev}>
            ← Previous
          </Button>
          <span className="uc-muted">Page {pagination.page}</span>
          <Button size="sm" onClick={pagination.onNext} disabled={!pagination.hasNext}>
            Next →
          </Button>
        </nav>
      )}
    </div>
  );
}

/** Cursor stack for server-side keyset pagination. Reset whenever filters change. */
export function useCursorPagination(resetKey: string) {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  useEffect(() => setStack([undefined]), [resetKey]);
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    page: stack.length,
    controls: (nextCursor: string | null | undefined) => ({
      page: stack.length,
      hasPrev: stack.length > 1,
      hasNext: Boolean(nextCursor),
      onPrev: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      onNext: () => nextCursor && setStack((s) => [...s, nextCursor]),
    }),
  };
}

// ---------------------------------------------------------------- unsaved changes

/** Warns on tab close/reload and on in-app link navigation while a form has unsaved edits. */
export function useUnsavedChangesWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest('a[href]');
      if (
        anchor &&
        !anchor.hasAttribute('download') &&
        !window.confirm('You have unsaved changes. Leave this page?')
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}

// ---------------------------------------------------------------- toasts

interface Toast {
  id: number;
  message: string;
  tone?: 'danger';
}
const ToastContext = createContext<(message: string, tone?: 'danger') => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone?: 'danger') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="uc-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="uc-toast" data-tone={t.tone}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VERSION_CONFLICT')
      return 'Someone else changed this record. Reload to see the latest version.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Unexpected error';
}

export function formatDateTime(value: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(
      new Date(value),
    );
  } catch {
    return value;
  }
}
