import { useMemo } from 'react';
import type { Session, Harness } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, projectName, localTime } from '../format';
import { useProjectsCollapsed } from '../hooks/useProjectsCollapsed';

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
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onErrorClick?: (sessionId: string) => void;
}

const HARNESS_COLOR: Record<Harness, string> = {
  claude_code: 'var(--harness-cc)',
  opencode: 'var(--harness-ad)',
  codex: 'var(--harness-cx)',
  cursor: 'var(--harness-cu)',
};

export function SessionList({
  sessions,
  activeId,
  setActiveId,
  collapsed,
  onToggleCollapsed,
  onErrorClick,
}: Props) {
  const projects = useMemo(() => summarizeProjects(sessions), [sessions]);
  const { collapsed: projectsCollapsed, toggle: toggleProjects } = useProjectsCollapsed();
  const activeSession = sessions.find((s) => s.session_id === activeId);

  if (collapsed) {
    return (
      <aside className="tb-pane tb-pane-left" data-collapsed="1">
        <div className="tb-pane-head tb-pane-head-collapsed">
          <button
            type="button"
            className="tb-pane-toggle"
            onClick={onToggleCollapsed}
            title="Show sessions"
            aria-label="Show sessions panel"
            aria-expanded={false}
          >
            <Icons.Chevron dir="right" size={14} />
          </button>
        </div>
        <button
          type="button"
          className="tb-pane-collapsed-rail"
          onClick={onToggleCollapsed}
          title="Show sessions"
          aria-label={`Show sessions panel (${sessions.length} sessions)`}
        >
          <span className="tb-pane-collapsed-count">{sessions.length}</span>
          <span className="tb-pane-collapsed-label">Sessions</span>
          {activeSession && (
            <span
              className="tb-pane-collapsed-dot"
              style={{ background: HARNESS_COLOR[activeSession.harness] ?? 'var(--mute-strong)' }}
              title={activeSession.title ?? activeSession.session_id}
            />
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside className="tb-pane tb-pane-left" data-collapsed="0">
      <div className="tb-pane-head">
        <span>Sessions</span>
        <span className="tb-pane-count">{sessions.length}</span>
        <button
          type="button"
          className="tb-pane-toggle"
          onClick={onToggleCollapsed}
          title="Hide sessions"
          aria-label="Hide sessions panel"
          aria-expanded={true}
        >
          <Icons.Chevron dir="left" size={14} />
        </button>
      </div>

      {projects.length > 0 && (
        <div className="tb-projects" data-collapsed={projectsCollapsed ? '1' : '0'}>
          <button
            type="button"
            className="tb-projects-head"
            onClick={toggleProjects}
            title={projectsCollapsed ? 'Show projects' : 'Hide projects'}
            aria-label={projectsCollapsed ? 'Show projects list' : 'Hide projects list'}
            aria-expanded={!projectsCollapsed}
          >
            <span>Projects</span>
            <Icons.Chevron dir={projectsCollapsed ? 'right' : 'down'} size={11} />
          </button>
          {!projectsCollapsed &&
            projects.slice(0, 8).map((p) => (
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
