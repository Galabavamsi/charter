import type { ReactNode } from 'react';
import { merchantErrorMessage } from './merchant-api';

export function MerchantPageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="merchant-page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id="merchant-leaf-heading" data-route-heading tabIndex={-1}>
          {title}
        </h2>
        <p>{description}</p>
      </div>
      {actions ? <div className="merchant-page-actions">{actions}</div> : null}
    </header>
  );
}

export function MerchantLoading({ label = 'Loading merchant records' }: { label?: string }) {
  return (
    <div className="merchant-skeleton" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

export function MerchantError({ error, retry }: { error: Error; retry(): Promise<void> | void }) {
  return (
    <div className="merchant-state merchant-state-error" role="alert">
      <strong>Records unavailable</strong>
      <p>{merchantErrorMessage(error)}</p>
      <button type="button" className="ghost" onClick={() => void retry()}>
        Try again
      </button>
    </div>
  );
}

export function MerchantEmpty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="merchant-state">
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function RecordStatus({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'ok' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <span className="record-status" data-tone={tone}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

export function FormNotice({ kind, children }: { kind: 'error' | 'success'; children: ReactNode }) {
  return (
    <p
      className="merchant-form-notice"
      data-kind={kind}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {children}
    </p>
  );
}
