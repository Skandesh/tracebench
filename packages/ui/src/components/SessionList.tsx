import { useMemo } from 'react';
import type { Session, Harness } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, projectName, localTime } from '../format';

interface ProjectSummary {
  name: string;
  count: number;
  lastActive: string;
}

/** Pure aggregation — extracted so it's testable and only runs when sessions change. */
function summarizeProjects(sessions: readonly Session[]): ProjectSummary[] {
  const byProject = new Map<string, { count: number; latest: string }>();
  for (const s of sessions) {
    const name = projectName(s.project_path);
    const prev = byProject.get(name);
    if (!prev) {
      byProject.set(name, { count: 1, latest: s.started_at });
    } else {
      prev.count++;
      if (s.started_at > prev.latest) prev.latest = s.started_at;
    }
  }
  const out: ProjectSummary[] = [];
  for (const [name, info] of byProject) {
    out.push({ name, count: info.count, lastActive: info.latest });
  }
  out.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  return out;
}

interface Props {
  sessions: Session[];
  activeId: string | null;
  setActiveId: (id: string) => void;
  /**
   * Called when a user clicks the "N err" badge on a session card. Receives
   * the session_id so the parent can (a) activate that session and (b) queue
   * an error-navigation intent that fires after turns load. Always provided —
   * works on inactive cards too.
   */
  onErrorClick?: (sessionId: string) => void;
}

const HARNESS_COLOR: Record<Harness, string> = {
  claude_code: 'var(--harness-cc)',
  opencode: 'var(--harness-ad)',
  codex: 'var(--harness-cx)',
  cursor: 'var(--mute-strong)',
};

export function SessionList({ sessions, activeId, setActiveId, onErrorClick }: Props) {
  const projects = useMemo(() => summarizeProjects(sessions), [sessions]);

  return (
    <aside className="tb-pane tb-pane-left">
      <div className="tb-pane-head">
        <span>Sessions</span>
        <span className="tb-pane-count">{sessions.length}</span>
      </div>

      {projects.length > 0 && (
        <div className="tb-projects">
          <div className="tb-projects-head">Projects</div>
          {projects.slice(0, 8).map((p) => (
            <div key={p.name} className="tb-project">
              <Icons.Folder size={11} />
              <span className="tb-project-name">{p.name}</span>
              <span className="tb-project-meta">{p.count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="tb-session-list">
        {sessions.map((s) => (
          <SessionCard
            key={s.session_id}
            session={s}
            active={s.session_id === activeId}
            onClick={() => setActiveId(s.session_id)}
            onErrorClick={onErrorClick}
          />
        ))}
        {sessions.length === 0 && (
          <div className="tb-empty">No sessions match.</div>
        )}
      </div>
    </aside>
  );
}

function SessionCard({
  session,
  active,
  onClick,
  onErrorClick,
}: {
  session: Session;
  active: boolean;
  onClick: () => void;
  onErrorClick?: (sessionId: string) => void;
}) {
  const harnessColor = HARNESS_COLOR[session.harness] ?? 'var(--mute-strong)';
  const idShort = session.session_id.slice(0, 8);
  const title = session.title ?? '(untitled session)';
  return (
    <button className="tb-sess" data-active={active ? '1' : '0'} onClick={onClick}>
      <div className="tb-sess-top">
        <span className="tb-sess-harness" style={{ background: harnessColor }} />
        <span className="tb-sess-id">{idShort}</span>
        <span className="tb-sess-time">{localTime(session.started_at)}</span>
      </div>
      <div className="tb-sess-title">{title}</div>
      <div className="tb-sess-bottom">
        <span className="tb-sess-project">{projectName(session.project_path)}</span>
        <span className="tb-sess-stats">
          <span>{formatDuration(session.aggregates.duration_ms)}</span>
          <span className="tb-sess-dot" />
          <span>{session.aggregates.tool_call_count} calls</span>
          <span className="tb-sess-dot" />
          <span>{formatCost(session.aggregates.total_cost_usd)}</span>
          {session.aggregates.tool_error_count > 0 && (
            <>
              <span className="tb-sess-dot" />
              {onErrorClick ? (
                <button
                  className="tb-sess-err tb-sess-err-btn"
                  onClick={(e) => {
                    // Don't let the click bubble up to the card button (which
                    // would also activate the session, racing the explicit
                    // handler). We activate + queue navigation here.
                    e.stopPropagation();
                    onErrorClick(session.session_id);
                  }}
                  title={active ? 'Jump to errors' : 'Open this session and jump to errors'}
                  aria-label={`${session.aggregates.tool_error_count} errors — open and jump to first error`}
                >
                  {session.aggregates.tool_error_count} err
                </button>
              ) : (
                <span className="tb-sess-err">{session.aggregates.tool_error_count} err</span>
              )}
            </>
          )}
        </span>
      </div>
    </button>
  );
}
