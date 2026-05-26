import { useMemo, useState } from 'react';
import type { Session, ToolCount, Turn } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, formatTokensCompact } from '../format';
import { ContextAnalyzer } from './ContextAnalyzer';
import { RailCollapsible } from './RailCollapsible';

type RailTab = 'overview' | 'context';

interface Props {
  session: Session;
  toolCounts: ToolCount[];
  turns: Turn[];
  onJumpToEvent?: (eventId: string) => void;
}

export function AnalyticsRail({ session, toolCounts, turns, onJumpToEvent }: Props) {
  const [tab, setTab] = useState<RailTab>('overview');
  const agg = session.aggregates;

  const totalIO = (agg.total_input_tokens + agg.total_output_tokens) || 1;
  const totalBilledTokens =
    agg.total_input_tokens +
    agg.total_output_tokens +
    agg.total_cache_read_tokens +
    agg.total_cache_creation_tokens;
  const totalAll = totalBilledTokens || 1;
  const cacheHitPct = ((agg.total_cache_read_tokens / totalAll) * 100).toFixed(0);

  const fileCounts = useMemo(() => {
    const map = new Map<string, { reads: number; edits: number; writes: number }>();
    for (const t of turns) {
      for (const e of t.events) {
        if (e.event_type !== 'tool_call') continue;
        const fp = (e.tool.input as { file_path?: string } | null)?.file_path;
        if (!fp) continue;
        const entry = map.get(fp) ?? { reads: 0, edits: 0, writes: 0 };
        if (e.tool.name === 'Read') entry.reads++;
        else if (e.tool.name === 'Edit') entry.edits++;
        else if (e.tool.name === 'Write') entry.writes++;
        map.set(fp, entry);
      }
    }
    return Array.from(map.entries())
      .map(([path, c]) => ({ path, ...c, total: c.reads + c.edits + c.writes }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
  }, [turns]);

  const totalToolCalls = toolCounts.reduce((a, c) => a + c.count, 0);

  return (
    <aside className="tb-pane tb-pane-right">
      <div className="tb-pane-head tb-rail-head">
        <div className="tb-rail-tabs" role="tablist" aria-label="Analytics views">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'overview'}
            className="tb-rail-tab"
            data-active={tab === 'overview' ? '1' : '0'}
            onClick={() => setTab('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'context'}
            className="tb-rail-tab"
            data-active={tab === 'context' ? '1' : '0'}
            onClick={() => setTab('context')}
          >
            Context
          </button>
        </div>
      </div>

      <div className="tb-rail-body">
        {tab === 'overview' ? (
          <>
            <div className="tb-rail-section tb-rail-section-loose">
              <p className="tb-rail-lead">Session totals at a glance.</p>
              <div className="tb-stat-grid">
                <Stat label="Cost" value={formatCost(agg.total_cost_usd)} sub={`${agg.turn_count} turns`} />
                <Stat label="Duration" value={formatDuration(agg.duration_ms)} sub="wall time" />
                <Stat label="Tool calls" value={agg.tool_call_count} sub={`${agg.message_count} messages`} />
                <Stat label="Cache hits" value={`${cacheHitPct}%`} sub="of billed tokens" />
              </div>
            </div>

            <div className="tb-rail-section">
              <div className="tb-section-head">Token mix</div>
              <TokenRow label="Input" value={agg.total_input_tokens} color="var(--accent)" pct={(agg.total_input_tokens / totalIO) * 100} />
              <TokenRow label="Output" value={agg.total_output_tokens} color="var(--harness-cx)" pct={(agg.total_output_tokens / totalIO) * 100} />
              <TokenRow label="Cache read" value={agg.total_cache_read_tokens} color="var(--mute-strong)" pct={(agg.total_cache_read_tokens / totalAll) * 100} />
              <TokenRow label="Cache write" value={agg.total_cache_creation_tokens} color="var(--mute-soft)" pct={(agg.total_cache_creation_tokens / totalAll) * 100} />
            </div>

            {toolCounts.length > 0 && (
              <RailCollapsible title="Tool mix" badge={`${totalToolCalls} calls`}>
                <ToolMix counts={toolCounts} total={totalToolCalls} />
              </RailCollapsible>
            )}

            {fileCounts.length > 0 && (
              <RailCollapsible title="File churn" badge={`${fileCounts.length} files`}>
                {fileCounts.map((f) => (
                  <div key={f.path} className="tb-file-row">
                    <span className="tb-file-path" title={f.path}>{f.path}</span>
                    <span className="tb-file-stats">
                      {f.reads > 0 && <span className="tb-f-r">R{f.reads}</span>}
                      {f.edits > 0 && <span className="tb-f-e">E{f.edits}</span>}
                      {f.writes > 0 && <span className="tb-f-w">W{f.writes}</span>}
                    </span>
                  </div>
                ))}
              </RailCollapsible>
            )}

            <div className="tb-rail-section tb-rail-hint">
              <p className="tb-mute">
                Open the <button type="button" className="tb-inline-link" onClick={() => setTab('context')}>Context</button> tab to inspect what filled the window, spot log gaps, and jump to heavy tool results.
              </p>
            </div>
          </>
        ) : (
          <ContextAnalyzer
            key={session.session_id}
            session={session}
            turns={turns}
            onJumpToEvent={onJumpToEvent}
          />
        )}
      </div>
    </aside>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub: string }) {
  return (
    <div className="tb-stat">
      <div className="tb-stat-label">{label}</div>
      <div className="tb-stat-value">{value}</div>
      <div className="tb-stat-sub">{sub}</div>
    </div>
  );
}

function TokenRow({ label, value, color, pct }: { label: string; value: number; color: string; pct: number }) {
  return (
    <div className="tb-tok-row">
      <div className="tb-tok-head">
        <span className="tb-tok-label">{label}</span>
        <span className="tb-tok-val">{formatTokensCompact(value)}</span>
      </div>
      <div className="tb-tok-bar">
        <div className="tb-tok-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

function ToolMix({ counts, total }: { counts: ToolCount[]; total: number }) {
  const colors = ['var(--accent)', 'var(--harness-cx)', 'var(--harness-ad)', 'var(--mute-strong)', 'var(--mute-soft)'];
  return (
    <div className="tb-mix">
      <div className="tb-mix-bar">
        {counts.map((c, i) => (
          <div
            key={c.tool_name}
            className="tb-mix-seg"
            style={{ width: `${(c.count / total) * 100}%`, background: colors[i % colors.length] }}
            title={`${c.tool_name}: ${c.count}`}
          />
        ))}
      </div>
      <div className="tb-mix-legend">
        {counts.slice(0, 8).map((c, i) => (
          <div key={c.tool_name} className="tb-mix-item">
            <Icons.Dot size={6} color={colors[i % colors.length]} />
            <span>{c.tool_name}</span>
            <span className="tb-mute">{c.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
