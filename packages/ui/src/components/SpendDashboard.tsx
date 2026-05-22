import type { Session } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, formatTokensCompact } from '../format';
import { useSpendAggregates } from '../hooks/useSpendAggregates';

interface Props {
  sessions: Session[];
  onClose: () => void;
}

const HARNESS_COLORS: Record<string, string> = {
  claude_code: 'var(--harness-cc)',
  codex: 'var(--harness-cx)',
  opencode: 'var(--harness-ad)',
  cursor: 'var(--harness-cu)',
};

export function SpendDashboard({ sessions, onClose }: Props) {
  const { grand, byHarness, byProject } = useSpendAggregates(sessions);

  const avgCostPerSession = grand.totalSessions > 0
    ? grand.totalCostUsd / grand.totalSessions
    : 0;
  const avgDuration = grand.totalSessions > 0
    ? grand.totalDurationMs / grand.totalSessions
    : 0;

  if (sessions.length === 0) {
    return (
      <div className="tb-dashboard">
        <div className="tb-dash-header">
          <div className="tb-dash-title-row">
            <h1 className="tb-dash-title">Spend Dashboard</h1>
            <button className="tb-dash-close" onClick={onClose} title="Back to sessions (d)">
              <Icons.Close size={16} />
            </button>
          </div>
        </div>
        <div className="tb-dash-empty">
          <p>No sessions indexed yet.</p>
          <p className="tb-mute">Sessions will appear here once tracebench indexes your agent logs.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tb-dashboard">
      <div className="tb-dash-header">
        <div className="tb-dash-title-row">
          <h1 className="tb-dash-title">Spend Dashboard</h1>
          <button className="tb-dash-close" onClick={onClose} title="Back to sessions (d)">
            <Icons.Close size={16} />
          </button>
        </div>
        <p className="tb-dash-subtitle">
          Aggregated across {grand.totalSessions.toLocaleString()} session{grand.totalSessions !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Summary Stats */}
      <div className="tb-dash-stats">
        <StatCard label="Total Spend" value={formatCost(grand.totalCostUsd)} accent />
        <StatCard label="Sessions" value={grand.totalSessions.toLocaleString()} />
        <StatCard label="Turns" value={grand.totalTurns.toLocaleString()} />
        <StatCard label="Tool Calls" value={grand.totalToolCalls.toLocaleString()} />
        <StatCard label="Avg $/Session" value={formatCost(avgCostPerSession)} />
        <StatCard label="Avg Duration" value={formatDuration(avgDuration)} />
      </div>

      {/* Token Summary */}
      <div className="tb-dash-section">
        <h2 className="tb-dash-section-head">Token Usage</h2>
        <div className="tb-dash-token-grid">
          <TokenStat label="Input" value={grand.totalInputTokens} color="var(--accent)" />
          <TokenStat label="Output" value={grand.totalOutputTokens} color="var(--harness-cx)" />
          <TokenStat label="Cache Read" value={grand.totalCacheReadTokens} color="var(--mute-strong)" />
          <TokenStat label="Cache Write" value={grand.totalCacheCreationTokens} color="var(--mute-soft)" />
        </div>
      </div>

      {/* By Provider */}
      {byHarness.length > 0 && (
        <div className="tb-dash-section">
          <h2 className="tb-dash-section-head">By Provider</h2>
          <div className="tb-dash-harness-list">
            {byHarness.map((h) => (
              <div key={h.harness} className="tb-dash-harness-row">
                <div className="tb-dash-harness-info">
                  <span
                    className="tb-dash-harness-dot"
                    style={{ background: HARNESS_COLORS[h.harness] ?? 'var(--text-mute)' }}
                  />
                  <span className="tb-dash-harness-name">{h.label}</span>
                  <span className="tb-dash-harness-meta">
                    {h.sessionCount} session{h.sessionCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="tb-dash-harness-bar-wrap">
                  <div
                    className="tb-dash-harness-bar"
                    style={{
                      width: `${Math.max(2, h.pct)}%`,
                      background: HARNESS_COLORS[h.harness] ?? 'var(--text-mute)',
                    }}
                  />
                </div>
                <div className="tb-dash-harness-cost">
                  <span className="tb-dash-harness-amount">{formatCost(h.totalCostUsd)}</span>
                  <span className="tb-dash-harness-pct">{h.pct.toFixed(1)}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Projects */}
      {byProject.length > 0 && (
        <div className="tb-dash-section">
          <h2 className="tb-dash-section-head">Top Projects</h2>
          <div className="tb-dash-project-list">
            {byProject.map((p, i) => (
              <div key={p.project} className="tb-dash-project-row">
                <span className="tb-dash-project-rank">{i + 1}</span>
                <span className="tb-dash-project-name" title={p.project}>{p.project}</span>
                <span className="tb-dash-project-cost">{formatCost(p.totalCostUsd)}</span>
                <span className="tb-dash-project-sessions">
                  {p.sessionCount} session{p.sessionCount !== 1 ? 's' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`tb-dash-card${accent ? ' tb-dash-card-accent' : ''}`}>
      <div className="tb-dash-card-value">{value}</div>
      <div className="tb-dash-card-label">{label}</div>
    </div>
  );
}

function TokenStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="tb-dash-token-stat">
      <span className="tb-dash-token-dot" style={{ background: color }} />
      <span className="tb-dash-token-label">{label}</span>
      <span className="tb-dash-token-value">{formatTokensCompact(value)}</span>
    </div>
  );
}
