import { useMemo } from 'react';
import type { Session, Turn, CanonicalEvent } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, localTime } from '../format';
import { ToolCallView } from '../tools/ToolCall';

interface Props {
  session: Session;
  turns: Turn[];
  loading: boolean;
  filterTool: string | null;
  setFilterTool: (t: string | null) => void;
}

export function Timeline({ session, turns, loading, filterTool, setFilterTool }: Props) {
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

  // Pair each tool_call with its tool_result by parent_event_id.
  const filteredTurns = useMemo(() => {
    if (!filterTool) return turns;
    return turns.map((t) => ({
      ...t,
      events: t.events.filter((e) => {
        if (e.event_type !== 'tool_call' && e.event_type !== 'tool_result') return true;
        if (e.event_type === 'tool_call') return e.tool.name === filterTool;
        // For tool_result, keep iff its matching tool_call has the filter name
        const matchingCall = t.events.find((x) => x.event_id === e.parent_event_id);
        return matchingCall?.tool.name === filterTool;
      }),
    }));
  }, [turns, filterTool]);

  return (
    <section className="tb-pane tb-pane-center">
      <SessionHeader
        session={session}
        toolCounts={toolCounts}
        filterTool={filterTool}
        setFilterTool={setFilterTool}
      />
      <div className="tb-timeline">
        {loading && <div className="tb-empty">Loading…</div>}
        {!loading && filteredTurns.map((turn, idx) => (
          <TurnGroup key={turn.turn_id} turnNumber={idx + 1} turn={turn} />
        ))}
        {!loading && turns.length === 0 && (
          <div className="tb-empty">No events.</div>
        )}
        {!loading && turns.length > 0 && (
          <div className="tb-timeline-end">
            <span className="tb-end-dot" />
            <span>
              Session ended · {formatDuration(session.aggregates.duration_ms)} · {session.aggregates.tool_error_count} errors
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
  setFilterTool,
}: {
  session: Session;
  toolCounts: Record<string, number>;
  filterTool: string | null;
  setFilterTool: (t: string | null) => void;
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
        <div className="tb-tool-filter">
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
              onClick={() => setFilterTool(filterTool === tool ? null : tool)}
            >
              {tool} <span className="tb-tf-c">{n}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TurnGroup({ turnNumber, turn }: { turnNumber: number; turn: Turn }) {
  // Build a map of tool_call event_id → tool_result event for pairing
  const resultByCallId = new Map<string, CanonicalEvent>();
  for (const e of turn.events) {
    if (e.event_type === 'tool_result' && e.parent_event_id) {
      resultByCallId.set(e.parent_event_id, e);
    }
  }

  return (
    <div className="tb-turn-group">
      <div className="tb-turn-rail">
        <span className="tb-turn-num">turn {turnNumber}</span>
        <span className="tb-turn-line" />
      </div>
      <div className="tb-turn-items">
        {turn.events.map((e) => {
          if (e.event_type === 'tool_result') return null; // rendered inside the tool_call
          if (e.event_type === 'meta') return null;
          if (e.event_type === 'tool_call') {
            return (
              <ToolCallView
                key={e.event_id}
                call={e}
                result={resultByCallId.get(e.event_id)}
              />
            );
          }
          return <MessageEntry key={e.event_id} event={e} />;
        })}
      </div>
    </div>
  );
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
