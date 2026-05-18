import { useMemo } from 'react';
import type { Session, ToolCount, Turn } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, formatTokensCompact } from '../format';

interface Props {
  session: Session;
  toolCounts: ToolCount[];
  turns: Turn[];
}

const CONTEXT_MAX_FALLBACK = 200_000;

export function AnalyticsRail({ session, toolCounts, turns }: Props) {
  const agg = session.aggregates;

  // Build a series of per-turn cumulative input + cache tokens so the
  // sparkline shows context growth over the session.
  const contextSeries = useMemo(() => {
    let running = 0;
    const series: number[] = [];
    for (const t of turns) {
      for (const e of t.events) {
        running = Math.max(
          running,
          (e.tokens.input ?? 0) +
            (e.tokens.cache_read ?? 0) +
            (e.tokens.cache_creation ?? 0),
        );
      }
      series.push(running);
    }
    return series.length > 0 ? series : [0];
  }, [turns]);

  const peak = Math.max(...contextSeries, 0);
  const ctxMax = guessContextMax(session.model);
  const peakPct = Math.min(100, (peak / ctxMax) * 100);

  const totalIO = (agg.total_input_tokens + agg.total_output_tokens) || 1;
  const totalBilledTokens =
    agg.total_input_tokens +
    agg.total_output_tokens +
    agg.total_cache_read_tokens +
    agg.total_cache_creation_tokens;
  const totalAll = totalBilledTokens || 1;

  const cacheHitPct = ((agg.total_cache_read_tokens / totalAll) * 100).toFixed(0);

  // File churn — top files touched. We don't have edit-vs-read split yet from
  // the API (files_touched is dedup'd), so we count occurrences from events.
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
      .slice(0, 10);
  }, [turns]);

  const totalToolCalls = toolCounts.reduce((a, c) => a + c.count, 0);

  return (
    <aside className="tb-pane tb-pane-right">
      <div className="tb-pane-head">
        <span>Analytics</span>
      </div>

      <div className="tb-rail-section">
        <div className="tb-stat-row">
          <Stat label="Cost" value={formatCost(agg.total_cost_usd)} sub={`${agg.turn_count} turns`} />
          <Stat label="Duration" value={formatDuration(agg.duration_ms)} sub="elapsed" />
        </div>
        <div className="tb-stat-row">
          <Stat label="Tool calls" value={agg.tool_call_count} sub={`${agg.message_count} msgs`} />
          <Stat label="Cache" value={`${cacheHitPct}%`} sub="of all tokens" />
        </div>
        <div className="tb-stat-row">
          {/* Use the total tokens billed against the session — including cache
              reads, which on Claude Code are typically 90% of input. Excluding
              them would make the per-turn average look 10× too small. */}
          <Stat
            label="Tokens/turn"
            value={agg.turn_count > 0 ? formatTokensCompact(totalBilledTokens / agg.turn_count) : '—'}
            sub="avg incl. cache"
          />
          <Stat
            label="Tokens/tool"
            value={agg.tool_call_count > 0 ? formatTokensCompact(totalBilledTokens / agg.tool_call_count) : '—'}
            sub="avg incl. cache"
          />
        </div>
      </div>

      <div className="tb-rail-section">
        <div className="tb-section-head">Context window</div>
        <div className="tb-ctx-bar">
          <div className="tb-ctx-fill" style={{ width: `${peakPct}%` }} />
          <div className="tb-ctx-label">
            <span>{(peak / 1000).toFixed(0)}k</span>
            <span className="tb-mute">/ {(ctxMax / 1000).toFixed(0)}k</span>
          </div>
        </div>
        <Sparkline data={contextSeries} />
        <div className="tb-ctx-legend">
          <span><Icons.Dot size={6} color="var(--accent)" /> peak per turn</span>
        </div>
      </div>

      <div className="tb-rail-section">
        <div className="tb-section-head">Tokens</div>
        <TokenRow label="Input" value={agg.total_input_tokens} color="var(--accent)" pct={(agg.total_input_tokens / totalIO) * 100} />
        <TokenRow label="Output" value={agg.total_output_tokens} color="var(--harness-cx)" pct={(agg.total_output_tokens / totalIO) * 100} />
        <TokenRow label="Cache read" value={agg.total_cache_read_tokens} color="var(--mute-strong)" pct={(agg.total_cache_read_tokens / totalAll) * 100} />
        <TokenRow label="Cache write" value={agg.total_cache_creation_tokens} color="var(--mute-soft)" pct={(agg.total_cache_creation_tokens / totalAll) * 100} />
      </div>

      {toolCounts.length > 0 && (
        <div className="tb-rail-section">
          <div className="tb-section-head">Tool mix</div>
          <ToolMix counts={toolCounts} total={totalToolCalls} />
        </div>
      )}

      {fileCounts.length > 0 && (
        <div className="tb-rail-section">
          <div className="tb-section-head">File churn</div>
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
        </div>
      )}
    </aside>
  );
}

function guessContextMax(model: string | null): number {
  if (!model) return CONTEXT_MAX_FALLBACK;
  if (/opus-4-7/.test(model)) return 1_000_000;
  return CONTEXT_MAX_FALLBACK;
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

function Sparkline({ data }: { data: number[] }) {
  const w = 240, h = 36, pad = 2;
  const max = Math.max(...data, 1);
  const step = (w - pad * 2) / Math.max(data.length - 1, 1);
  const points = data.map((v, i) => `${pad + i * step},${h - pad - (v / max) * (h - pad * 2)}`);
  const path = `M${points.join(' L')}`;
  const area = `${path} L${pad + (data.length - 1) * step},${h - pad} L${pad},${h - pad} Z`;
  return (
    <svg className="tb-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill="var(--accent)" opacity="0.12" />
      <path d={path} stroke="var(--accent)" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function TokenRow({ label, value, color, pct }: { label: string; value: number; color: string; pct: number }) {
  return (
    <div className="tb-tok-row">
      <div className="tb-tok-head">
        <span className="tb-tok-label">{label}</span>
        <span className="tb-tok-val">{value.toLocaleString()}</span>
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
