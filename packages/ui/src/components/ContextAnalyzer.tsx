import { useMemo, useState, type ReactNode } from 'react';
import {
  analyzeSessionContext,
  guessContextMax,
  type MissingLogItem,
  type SessionContextAnalysis,
  type ToolResultContextImpact,
} from '@tracebench/core/context-analyzer';
import type { ContextComponentKind } from '@tracebench/core/schema';
import pricingTable from '@tracebench/core/pricing.json';
import type { PricingTable } from '@tracebench/core/pricing-calc';
import type { Session, Turn } from '../types';
import { Icons } from '../icons';
import { formatCost, formatTokensCompact } from '../format';
import { RailCollapsible } from './RailCollapsible';

interface Props {
  session: Session;
  turns: Turn[];
  onJumpToEvent?: (eventId: string) => void;
}

const KIND_COLORS: Record<ContextComponentKind, string> = {
  system: 'var(--mute-strong)',
  tool_descriptions: 'var(--text-faint)',
  prior_assistant: 'var(--harness-cx)',
  prior_tool_output: 'var(--accent)',
  prior_user: 'var(--harness-ad)',
  current_user: 'var(--harness-ad)',
  thinking: 'var(--mute-soft)',
};

const KIND_LABELS: Record<ContextComponentKind, string> = {
  system: 'System',
  tool_descriptions: 'Tools',
  prior_assistant: 'Prior assistant',
  prior_tool_output: 'Tool output',
  prior_user: 'Prior user',
  current_user: 'Current user',
  thinking: 'Thinking',
};

const MISSING_LABELS: Record<MissingLogItem['kind'], string> = {
  missing_tool_result: 'Missing result',
  orphan_tool_result: 'Orphan result',
  empty_tool_output: 'Empty output',
  harness_no_tool_results: 'Log gap',
};

const OFFENDER_PREVIEW = 5;

export function ContextAnalyzer({ session, turns, onJumpToEvent }: Props) {
  const analysis = useMemo(
    () =>
      analyzeSessionContext(
        turns as Parameters<typeof analyzeSessionContext>[0],
        session.model,
        {
          pricingTable: pricingTable as PricingTable,
          harness: session.harness,
        },
      ),
    [turns, session.model, session.harness],
  );

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

  const [turnIndex, setTurnIndex] = useState<number>(() => Math.max(0, turns.length - 1));
  const [showAllOffenders, setShowAllOffenders] = useState(false);

  const safeIndex = Math.min(Math.max(0, turnIndex), Math.max(0, analysis.snapshots.length - 1));
  const snapshot = analysis.snapshots[safeIndex];
  const totalTokens = snapshot?.components.reduce((s, c) => s + c.token_count, 0) ?? 0;
  const ctxMax = snapshot?.max_context_tokens ?? guessContextMax(session.model, pricingTable as PricingTable);
  const peakPct = Math.min(100, ctxMax > 0 ? (totalTokens / ctxMax) * 100 : 0);
  const categoryEntries = Object.entries(analysis.categoryTotals) as [ContextComponentKind, number][];
  const visibleOffenders = showAllOffenders
    ? analysis.topOffenders
    : analysis.topOffenders.slice(0, OFFENDER_PREVIEW);
  const hiddenOffenderCount = Math.max(0, analysis.topOffenders.length - OFFENDER_PREVIEW);

  if (turns.length === 0) return null;

  return (
    <>
      {analysis.missingLogs.length > 0 && (
        <div className="tb-rail-section tb-ctx-missing-section">
          <div className="tb-section-head">Log gaps</div>
          <p className="tb-rail-lead">
            These issues limit how accurately we can reconstruct context. Click an item to inspect it on the timeline.
          </p>
          <ul className="tb-ctx-missing-list">
            {analysis.missingLogs.map((m, i) => (
              <li key={`${m.kind}-${m.jump_event_id ?? i}`}>
                <JumpButton
                  className="tb-ctx-missing-item"
                  eventId={m.jump_event_id}
                  onJump={onJumpToEvent}
                >
                  <span className={`tb-ctx-missing-kind tb-ctx-missing-${m.kind}`}>
                    {MISSING_LABELS[m.kind]}
                  </span>
                  <span className="tb-ctx-missing-desc">{m.description}</span>
                  {m.turn_index >= 0 && m.jump_event_id && (
                    <span className="tb-ctx-missing-meta">Turn {m.turn_index + 1} · jump</span>
                  )}
                </JumpButton>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="tb-rail-section tb-rail-section-loose">
        <div className="tb-section-head">Window fill</div>
        <p className="tb-rail-lead">
          Estimated composition at a chosen turn. Sizes are approximate (~4 chars per token).
        </p>

        <div className="tb-ctx-peak">
          <span className="tb-ctx-peak-val">{peakPct.toFixed(0)}%</span>
          <span className="tb-mute">
            {formatTokensCompact(totalTokens)} of {formatTokensCompact(ctxMax)}
          </span>
        </div>

        <Sparkline data={contextSeries} />
        <div className="tb-ctx-legend">
          <span><Icons.Dot size={6} color="var(--accent)" /> Billed input peak per turn</span>
        </div>

        {analysis.snapshots.length > 1 && (
          <div className="tb-ctx-turn-select">
            <label htmlFor="ctx-turn">Inspect turn</label>
            <select
              id="ctx-turn"
              value={safeIndex}
              onChange={(e) => setTurnIndex(Number(e.target.value))}
            >
              {analysis.snapshots.map((s, i) => {
                const delta = analysis.turnDeltas[i];
                return (
                  <option key={s.turn_id} value={i}>
                    Turn {i + 1}
                    {delta && delta.delta_tokens > 0 ? ` (+${formatTokensCompact(delta.delta_tokens)})` : ''}
                  </option>
                );
              })}
            </select>
          </div>
        )}

        {snapshot && totalTokens > 0 && (
          <CompositionBar
            snapshot={snapshot}
            zones={analysis.attentionZones}
            totalTokens={totalTokens}
          />
        )}

        {categoryEntries.length > 0 && (
          <ul className="tb-ctx-category-list">
            {categoryEntries
              .sort((a, b) => b[1] - a[1])
              .map(([kind, count]) => (
                <li key={kind}>
                  <span className="tb-ctx-cat-dot" style={{ background: KIND_COLORS[kind] }} />
                  <span className="tb-ctx-list-kind">{KIND_LABELS[kind]}</span>
                  <span className="tb-ctx-cat-val">{formatTokensCompact(count)}</span>
                  <span className="tb-mute">{totalTokens > 0 ? `${((count / totalTokens) * 100).toFixed(0)}%` : ''}</span>
                </li>
              ))}
          </ul>
        )}

        {analysis.growthRate && (
          <div className="tb-ctx-growth">
            Fastest growing category: <span>{KIND_LABELS[analysis.growthRate]}</span>
          </div>
        )}
      </div>

      {analysis.topOffenders.length > 0 && (
        <div className="tb-rail-section">
          <div className="tb-section-head">Heaviest tool results</div>
          <p className="tb-rail-lead">Single calls that added the most reconstructed context.</p>
          <ul className="tb-ctx-list tb-ctx-list-loose">
            {visibleOffenders.map((o) => (
              <li key={o.result_event_id ?? o.call_event_id ?? o.label}>
                <JumpButton
                  className="tb-ctx-offender-item"
                  eventId={o.result_event_id ?? o.call_event_id}
                  onJump={onJumpToEvent}
                >
                  <span className="tb-ctx-offender-label">{o.label}</span>
                  <span className="tb-ctx-offender-meta">
                    Turn {o.turn_index + 1} · ~{formatTokensCompact(o.estimated_tokens)}
                  </span>
                </JumpButton>
              </li>
            ))}
          </ul>
          {hiddenOffenderCount > 0 && !showAllOffenders && (
            <button
              type="button"
              className="tb-ctx-show-more"
              onClick={() => setShowAllOffenders(true)}
            >
              Show {hiddenOffenderCount} more
            </button>
          )}
        </div>
      )}

      {analysis.wasteItems.length > 0 && (
        <RailCollapsible title="Waste" badge={`${analysis.wasteItems.length}`}>
          <ul className="tb-ctx-list tb-ctx-list-loose">
            {analysis.wasteItems.map((w, i) => (
              <li key={`${w.source_event_id}-${i}`}>
                <JumpButton
                  className="tb-ctx-waste-item"
                  eventId={w.related_event_id ?? w.source_event_id}
                  onJump={onJumpToEvent}
                >
                  <span className="tb-ctx-waste-desc">{w.description}</span>
                  <span className="tb-ctx-waste-meta">
                    ~{formatTokensCompact(w.estimated_tokens)}
                    {w.estimated_cost_usd != null && ` · ${formatCost(w.estimated_cost_usd)}`}
                  </span>
                </JumpButton>
              </li>
            ))}
          </ul>
        </RailCollapsible>
      )}

      {analysis.valleyFlags.length > 0 && (
        <RailCollapsible title="Attention valley" badge={`${analysis.valleyFlags.length}`}>
          <ul className="tb-ctx-list tb-ctx-list-loose">
            {analysis.valleyFlags.map((f, i) => (
              <li key={`${f.component.source_event_id}-${i}`}>
                <span className="tb-ctx-list-kind">{KIND_LABELS[f.component.kind]}</span>
                <span className="tb-mute">{f.reason}</span>
              </li>
            ))}
          </ul>
        </RailCollapsible>
      )}

      {analysis.suggestions.length > 0 && (
        <RailCollapsible title="Suggestions" badge={`${analysis.suggestions.length}`}>
          <ul className="tb-ctx-suggestions">
            {analysis.suggestions.map((s, i) => (
              <li key={i}>
                <span className={`tb-ctx-sug-kind tb-ctx-sug-${s.kind}`}>{s.kind}</span>
                {s.reason}
              </li>
            ))}
          </ul>
        </RailCollapsible>
      )}

      <div className="tb-rail-section tb-ctx-methodology">
        <p className="tb-mute">
          Reconstructed from session logs — not the exact API prompt. Attention zones use a positional heuristic (Liu et al.).
        </p>
      </div>
    </>
  );
}

function JumpButton({
  eventId,
  onJump,
  className,
  children,
}: {
  eventId: string | null;
  onJump?: (eventId: string) => void;
  className?: string;
  children: ReactNode;
}) {
  if (eventId && onJump) {
    return (
      <button type="button" className={className} onClick={() => onJump(eventId)}>
        {children}
      </button>
    );
  }
  return <div className={className}>{children}</div>;
}

function Sparkline({ data }: { data: number[] }) {
  const w = 280, h = 40, pad = 4;
  const max = Math.max(...data, 1);
  const step = (w - pad * 2) / Math.max(data.length - 1, 1);
  const points = data.map((v, i) => `${pad + i * step},${h - pad - (v / max) * (h - pad * 2)}`);
  const path = `M${points.join(' L')}`;
  const area = `${path} L${pad + (data.length - 1) * step},${h - pad} L${pad},${h - pad} Z`;
  return (
    <svg className="tb-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill="var(--accent)" opacity="0.1" />
      <path d={path} stroke="var(--accent)" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function CompositionBar({
  snapshot,
  zones,
  totalTokens,
}: {
  snapshot: SessionContextAnalysis['snapshots'][number];
  zones: SessionContextAnalysis['attentionZones'];
  totalTokens: number;
}) {
  const pct = (n: number) => (totalTokens > 0 ? (n / totalTokens) * 100 : 0);

  return (
    <div className="tb-ctx-compose-wrap">
      <div className="tb-ctx-compose-bar">
        {snapshot.components.map((c, i) => (
          <div
            key={`${c.source_event_id}-${i}`}
            className="tb-ctx-compose-seg"
            style={{
              width: `${pct(c.token_count)}%`,
              background: KIND_COLORS[c.kind],
              opacity: c.cached ? 0.55 : 0.85,
            }}
            title={`${KIND_LABELS[c.kind]}: ${c.token_count.toLocaleString()} tokens`}
          />
        ))}
      </div>
      <div className="tb-ctx-compose-legend">
        {(Object.keys(KIND_LABELS) as ContextComponentKind[])
          .filter((k) => snapshot.components.some((c) => c.kind === k))
          .map((k) => (
            <span key={k}>
              <i style={{ background: KIND_COLORS[k] }} />
              {KIND_LABELS[k]}
            </span>
          ))}
      </div>
      <details className="tb-ctx-zones-help">
        <summary>Attention zones (heuristic)</summary>
        <div className="tb-ctx-compose-zones" aria-hidden="true">
          <div className="tb-ctx-zone tb-ctx-zone-primacy" style={{ width: `${pct(zones.primacy_end)}%` }} />
          <div
            className="tb-ctx-zone tb-ctx-zone-valley"
            style={{ width: `${pct(zones.valley_end - zones.valley_start)}%` }}
          />
          <div
            className="tb-ctx-zone tb-ctx-zone-recency"
            style={{ width: `${pct(zones.recency_end - zones.recency_start)}%` }}
          />
        </div>
        <div className="tb-ctx-zone-labels">
          <span>Primacy</span>
          <span>Valley</span>
          <span>Recency</span>
        </div>
      </details>
    </div>
  );
}

export type { ToolResultContextImpact };
