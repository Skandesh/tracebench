import type { ReactNode } from 'react';

interface Props {
  title: string;
  /** Short count or hint shown on the closed row. */
  badge?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

/** Collapsible block inside the analytics rail — progressive disclosure. */
export function RailCollapsible({ title, badge, defaultOpen = false, children }: Props) {
  return (
    <details className="tb-rail-collapse" open={defaultOpen || undefined}>
      <summary className="tb-rail-collapse-summary">
        <span className="tb-rail-collapse-title">{title}</span>
        {badge ? <span className="tb-rail-collapse-badge">{badge}</span> : null}
      </summary>
      <div className="tb-rail-collapse-body">{children}</div>
    </details>
  );
}
