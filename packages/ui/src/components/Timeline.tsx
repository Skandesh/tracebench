import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type Ref,
  type SetStateAction,
} from 'react';
import {
  analyzeSessionContext,
  type ToolResultContextImpact,
} from '@tracebench/core/context-analyzer';
import pricingTable from '@tracebench/core/pricing.json';
import type { PricingTable } from '@tracebench/core/pricing-calc';
import type { Session, Turn, CanonicalEvent } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, formatTokensCompact, localTime } from '../format';
import { indexToolResultsByCall, listFilteredToolCalls } from '../selectors';
import { ToolCallView } from '../tools/ToolCall';

/** Initial + incremental batch size for filtered tool-call rendering. */
const FILTER_RENDER_BATCH = 80;

interface Props {
  session: Session;
  turns: Turn[];
  loading: boolean;
  filterTool: string | null;
  setFilterTool: Dispatch<SetStateAction<string | null>>;
  timelineRef?: Ref<HTMLDivElement>;
  errorEventIds?: string[];
  activeErrorIndex?: number | null;
  onErrorClick?: () => void;
  onClearErrorHighlight?: () => void;
  inspectorHighlightId?: string | null;
  onClearInspectorHighlight?: () => void;
}

export function Timeline({
  session,
  turns,
  loading,
  filterTool,
  setFilterTool,
  timelineRef,
  errorEventIds,
  activeErrorIndex,
  onErrorClick,
  onClearErrorHighlight,
  inspectorHighlightId,
  onClearInspectorHighlight,
}: Props) {
  const deferredFilterTool = useDeferredValue(filterTool);
  // Pending only while switching between tool filters — not when clearing to All.
  const filterPending = filterTool != null && filterTool !== deferredFilterTool;

  const highlightedEventId =
    activeErrorIndex != null && errorEventIds && errorEventIds.length > 0
      ? errorEventIds[activeErrorIndex] ?? null
      : null;

  const contextAnalysis = useMemo(
    () =>
      analyzeSessionContext(
        turns as Parameters<typeof analyzeSessionContext>[0],
        session.model,
        { pricingTable: pricingTable as PricingTable, harness: session.harness },
      ),
    [turns, session.model, session.harness],
  );

  const impactByCallId = useMemo(() => {
    const m = new Map<string, ToolResultContextImpact>();
    for (const impact of contextAnalysis.toolResultImpacts) {
      if (impact.call_event_id) m.set(impact.call_event_id, impact);
    }
    return m;
  }, [contextAnalysis.toolResultImpacts]);

  const impactByResultId = useMemo(() => {
    const m = new Map<string, ToolResultContextImpact>();
    for (const impact of contextAnalysis.toolResultImpacts) {
      if (impact.result_event_id) m.set(impact.result_event_id, impact);
    }
    return m;
  }, [contextAnalysis.toolResultImpacts]);

  const turnDeltaByIndex = useMemo(() => {
    const m = new Map<number, number>();
    for (const d of contextAnalysis.turnDeltas) {
      m.set(d.turn_index, d.delta_tokens);
    }
    return m;
  }, [contextAnalysis.turnDeltas]);

  const isEventHighlighted = useCallback(
    (callId: string, resultId?: string) =>
      callId === highlightedEventId ||
      callId === inspectorHighlightId ||
      (resultId != null && resultId === inspectorHighlightId),
    [highlightedEventId, inspectorHighlightId],
  );

  const onClearHighlight = useCallback(() => {
    onClearErrorHighlight?.();
    onClearInspectorHighlight?.();
  }, [onClearErrorHighlight, onClearInspectorHighlight]);

  const toolCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of turns) {
      for (const e of t.events) {
        if (e.event_type === 'tool_call' && e.tool.name) {
          counts[e.tool.name] = (counts[e.tool.name] ?? 0) + 1;
        }
      }
    }
    return counts;
  }, [turns]);

  const filteredPairs = useMemo(
    () =>
      deferredFilterTool
        ? listFilteredToolCalls(turns, deferredFilterTool)
        : [],
    [turns, deferredFilterTool],
  );

  const [visibleLimit, setVisibleLimit] = useState(FILTER_RENDER_BATCH);
  useEffect(() => {
    setVisibleLimit(FILTER_RENDER_BATCH);
  }, [deferredFilterTool, session.session_id]);

  const visiblePairs = useMemo(
    () => filteredPairs.slice(0, visibleLimit),
    [filteredPairs, visibleLimit],
  );

  useEffect(() => {
    if (filterPending) return;
    const el =
      timelineRef && typeof timelineRef === 'object' && 'current' in timelineRef
        ? timelineRef.current
        : null;
    if (!el) return;
    if (!deferredFilterTool) {
      el.scrollTop = 0;
      return;
    }
    const first = el.querySelector('[data-event-id]');
    first?.scrollIntoView({ block: 'start' });
  }, [deferredFilterTool, filterPending, session.session_id, timelineRef]);

  const showFiltered = filterTool != null;
  const hasMoreFiltered = visiblePairs.length < filteredPairs.length;
  const showFilteredContent = showFiltered && !filterPending && filteredPairs.length > 0;

  return (
    <section className="tb-pane tb-pane-center">
      <SessionHeader
        session={session}
        toolCounts={toolCounts}
        filterTool={filterTool}
        filterPending={filterPending}
        setFilterTool={setFilterTool}
      />
      <div
        className="tb-timeline"
        ref={timelineRef}
        data-filter-pending={filterPending ? '1' : '0'}
      >
        {loading && <div className="tb-empty">Loading…</div>}
        {!loading && !showFiltered && turns.map((turn, idx) => (
          <TurnGroup
            key={turn.turn_id}
            turnNumber={idx + 1}
            turn={turn}
            turnDelta={turnDeltaByIndex.get(idx) ?? 0}
            highlightedEventId={highlightedEventId}
            inspectorHighlightId={inspectorHighlightId}
            impactByCallId={impactByCallId}
            impactByResultId={impactByResultId}
            onClearHighlight={onClearHighlight}
            isEventHighlighted={isEventHighlighted}
          />
        ))}
        {!loading && showFiltered && filterPending && (
          <div className="tb-empty">Updating filter…</div>
        )}
        {!loading && showFilteredContent && (
          <>
            <div className="tb-filter-summary">
              {filteredPairs.length.toLocaleString()} {deferredFilterTool} call
              {filteredPairs.length === 1 ? '' : 's'}
              {hasMoreFiltered && (
                <>
                  {' · '}
                  showing {visiblePairs.length.toLocaleString()}
                </>
              )}
            </div>
            <div className="tb-filter-list">
              {visiblePairs.map(({ call, result }) => (
                <ToolCallView
                  key={call.event_id}
                  call={call}
                  result={result}
                  defaultOpen={false}
                  contextImpact={impactByCallId.get(call.event_id)}
                  highlighted={isEventHighlighted(call.event_id, result?.event_id)}
                  onClearHighlight={onClearHighlight}
                />
              ))}
            </div>
            {hasMoreFiltered && (
              <button
                type="button"
                className="tb-filter-more"
                onClick={() =>
                  setVisibleLimit((n) =>
                    Math.min(n + FILTER_RENDER_BATCH, filteredPairs.length),
                  )
                }
              >
                Load more ({(filteredPairs.length - visiblePairs.length).toLocaleString()}{' '}
                remaining)
              </button>
            )}
          </>
        )}
        {!loading && turns.length === 0 && (
          <div className="tb-empty">No events.</div>
        )}
        {!loading && showFiltered && !filterPending && filteredPairs.length === 0 && turns.length > 0 && (
          <div className="tb-empty">No {deferredFilterTool} calls in this session.</div>
        )}
        {!loading && turns.length > 0 && (!showFiltered || showFilteredContent) && (
          <div className="tb-timeline-end">
            <span className="tb-end-dot" />
            <span>
              Session ended · {formatDuration(session.aggregates.duration_ms)} ·{' '}
              {session.aggregates.tool_error_count > 0 ? (
                <button
                  className="tb-timeline-end-err"
                  onClick={onErrorClick}
                  title={`Click to cycle through ${session.aggregates.tool_error_count} errors`}
                >
                  {session.aggregates.tool_error_count} errors
                </button>
              ) : (
                <span>{session.aggregates.tool_error_count} errors</span>
              )}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function SessionHeader({
  session,
  toolCounts,
  filterTool,
  filterPending,
  setFilterTool,
}: {
  session: Session;
  toolCounts: Record<string, number>;
  filterTool: string | null;
  filterPending: boolean;
  setFilterTool: Dispatch<SetStateAction<string | null>>;
}) {
  const sortedTools = useMemo(
    () => Object.entries(toolCounts).sort((a, b) => b[1] - a[1]),
    [toolCounts],
  );
  return (
    <div className="tb-sess-head">
      <div className="tb-sess-head-row">
        <h1 className="tb-sess-head-title">{session.title ?? '(untitled session)'}</h1>
        <span className="tb-sess-head-id">{session.session_id.slice(0, 8)}</span>
      </div>
      <div className="tb-sess-head-meta">
        <span className="tb-meta-item"><Icons.Folder size={11} />{session.project_path}</span>
        <span className="tb-meta-item"><Icons.Clock size={11} />{formatDuration(session.aggregates.duration_ms)}</span>
        {session.model && <span className="tb-meta-item"><Icons.Hash size={11} />{session.model}</span>}
        <span className="tb-meta-item"><Icons.Coin size={11} />{formatCost(session.aggregates.total_cost_usd)}</span>
      </div>
      {sortedTools.length > 0 && (
        <div className="tb-tool-filter" data-pending={filterPending ? '1' : '0'}>
          <button
            className="tb-tf-btn"
            data-active={!filterTool ? '1' : '0'}
            onClick={() => setFilterTool(null)}
          >
            All <span className="tb-tf-c">{session.aggregates.tool_call_count}</span>
          </button>
          {sortedTools.slice(0, 8).map(([tool, n]) => (
            <button
              key={tool}
              className="tb-tf-btn"
              data-active={filterTool === tool ? '1' : '0'}
              onClick={() => setFilterTool((prev) => (prev === tool ? null : tool))}
            >
              {tool} <span className="tb-tf-c">{n}</span>
            </button>
          ))}
          {filterPending && (
            <span className="tb-tf-pending" aria-live="polite">
              Updating…
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const TurnGroup = memo(function TurnGroup({
  turnNumber,
  turn,
  turnDelta,
  highlightedEventId,
  inspectorHighlightId,
  impactByCallId,
  impactByResultId,
  onClearHighlight,
  isEventHighlighted,
}: {
  turnNumber: number;
  turn: Turn;
  turnDelta: number;
  highlightedEventId?: string | null;
  inspectorHighlightId?: string | null;
  impactByCallId: Map<string, ToolResultContextImpact>;
  impactByResultId: Map<string, ToolResultContextImpact>;
  onClearHighlight?: () => void;
  isEventHighlighted: (callId: string, resultId?: string) => boolean;
}) {
  const resultByCallId = useMemo(() => indexToolResultsByCall(turn.events), [turn.events]);
  const callIdsInTurn = useMemo(() => {
    const s = new Set<string>();
    for (const e of turn.events) {
      if (e.event_type === 'tool_call') s.add(e.event_id);
    }
    return s;
  }, [turn.events]);

  return (
    <div className="tb-turn-group">
      <div className="tb-turn-rail">
        <span className="tb-turn-num">turn {turnNumber}</span>
        {turnDelta > 0 && (
          <span className="tb-turn-delta">+{formatTokensCompact(turnDelta)}</span>
        )}
        <span className="tb-turn-line" />
      </div>
      <div className="tb-turn-items">
        {turn.events.map((e) => {
          if (e.event_type === 'tool_result') {
            const parentInTurn = e.parent_event_id != null && callIdsInTurn.has(e.parent_event_id);
            if (parentInTurn && e.metadata?.orphan !== true) return null;
            const impact = impactByResultId.get(e.event_id);
            return (
              <OrphanToolResultView
                key={e.event_id}
                event={e}
                impact={impact}
                highlighted={e.event_id === inspectorHighlightId || e.event_id === highlightedEventId}
                onClearHighlight={onClearHighlight}
              />
            );
          }
          if (e.event_type === 'meta') return null;
          if (e.event_type === 'tool_call') {
            const result = resultByCallId.get(e.event_id);
            return (
              <ToolCallView
                key={e.event_id}
                call={e}
                result={result}
                contextImpact={impactByCallId.get(e.event_id)}
                highlighted={isEventHighlighted(e.event_id, result?.event_id)}
                onClearHighlight={onClearHighlight}
              />
            );
          }
          return <MessageEntry key={e.event_id} event={e} />;
        })}
      </div>
    </div>
  );
});

function OrphanToolResultView({
  event,
  impact,
  highlighted,
  onClearHighlight,
}: {
  event: CanonicalEvent;
  impact?: ToolResultContextImpact;
  highlighted?: boolean;
  onClearHighlight?: () => void;
}) {
  useHighlightAutoClear(highlighted, onClearHighlight);
  const output =
    typeof event.tool.output === 'string'
      ? event.tool.output
      : event.tool.output != null
        ? JSON.stringify(event.tool.output)
        : '';

  return (
    <div
      className={`tb-tool tb-tool-orphan${highlighted ? ' tb-tool-highlighted' : ''}`}
      data-event-id={event.event_id}
    >
      <div className="tb-tool-head tb-tool-head-static">
        <span className="tb-tool-ico tb-tool-read"><Icons.Hash size={12} /></span>
        <span className="tb-tool-name">Orphan result</span>
        <span className="tb-tool-summary tb-tool-log-missing">
          Tool call missing from log — often after compaction
        </span>
        <span className="tb-tool-meta">
          {impact && impact.estimated_tokens > 0 && (
            <span className="tb-tool-tok">~{formatTokensCompact(impact.estimated_tokens)} tok</span>
          )}
        </span>
      </div>
      {output && (
        <div className="tb-tool-body tb-read-body">
          <pre className="tb-pre">{output.slice(0, 2000)}{output.length > 2000 ? '\n…' : ''}</pre>
        </div>
      )}
    </div>
  );
}

function useHighlightAutoClear(highlighted: boolean | undefined, onClearHighlight: (() => void) | undefined): void {
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => onClearHighlight?.(), 1200);
    return () => clearTimeout(timer);
  }, [highlighted, onClearHighlight]);
}

function MessageEntry({ event }: { event: CanonicalEvent }) {
  const content = typeof event.content === 'string' ? event.content : event.content ? JSON.stringify(event.content) : '';
  if (event.role === 'user') {
    return (
      <div className="tb-msg tb-msg-user">
        <div className="tb-msg-head">
          <span className="tb-role">user</span>
          <span className="tb-msg-time">{localTime(event.timestamp)}</span>
        </div>
        <div className="tb-msg-body">{content}</div>
      </div>
    );
  }
  if (event.event_type === 'thinking') {
    return (
      <details className="tb-msg tb-msg-think">
        <summary className="tb-msg-head">
          <span className="tb-role tb-role-asst">thinking</span>
          <span className="tb-msg-time">{localTime(event.timestamp)}</span>
        </summary>
        <div className="tb-msg-body">{content}</div>
      </details>
    );
  }
  if (event.event_type === 'summary' || event.event_type === 'compaction') {
    return (
      <div className="tb-msg tb-msg-think">
        <div className="tb-msg-head">
          <span className="tb-role">{event.event_type}</span>
          <span className="tb-msg-time">{localTime(event.timestamp)}</span>
        </div>
        <div className="tb-msg-body">{content}</div>
      </div>
    );
  }
  return (
    <div className="tb-msg tb-msg-asst">
      <div className="tb-msg-head">
        <span className="tb-role tb-role-asst">assistant</span>
        <span className="tb-msg-time">{localTime(event.timestamp)}</span>
        {event.tokens.input != null && (
          <span className="tb-msg-toks">
            in {event.tokens.input.toLocaleString()} · out {(event.tokens.output ?? 0).toLocaleString()}
            {event.cost_usd != null && ` · ${formatCost(event.cost_usd)}`}
          </span>
        )}
      </div>
      <div className="tb-msg-body">{content}</div>
    </div>
  );
}
