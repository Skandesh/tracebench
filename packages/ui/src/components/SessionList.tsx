import { useMemo } from 'react';
import type { Session, Harness } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, projectName, localTime } from '../format';
import { useProjectsCollapsed } from '../hooks/useProjectsCollapsed';
import { HARNESS_COLORS } from '../constants';

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
  sessionsForProjects: Session[];
  filterProject: string | null;
  setFilterProject: (name: string | null) => void;
  activeId: string | null;
  setActiveId: (id: string) => void;
  onIndexSession?: (id: string) => void;
  indexingId?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onErrorClick?: (sessionId: string) => void;
}

export function SessionList({
  sessions,
  sessionsForProjects,
  filterProject,
  setFilterProject,
  activeId,
  setActiveId,
  onIndexSession,
  indexingId,
  collapsed,
  onToggleCollapsed,
  onErrorClick,
}: Props) {
  const projects = useMemo(
    () => summarizeProjects(sessionsForProjects),
    [sessionsForProjects],
  );
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
              style={{ background: HARNESS_COLORS[activeSession.harness] ?? 'var(--mute-strong)' }}
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
              <button
                key={p.name}
                type="button"
                className="tb-project"
                data-active={filterProject === p.name ? '1' : '0'}
                onClick={() =>
                  setFilterProject(filterProject === p.name ? null : p.name)
                }
                title={
                  filterProject === p.name
                    ? 'Show all projects'
                    : `Show only ${p.name}`
                }
              >
                <Icons.Folder size={11} />
                <span className="tb-project-name">{p.name}</span>
                <span className="tb-project-meta">{p.count}</span>
              </button>
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
            onIndexSession={onIndexSession}
            indexing={indexingId === s.session_id}
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
  onIndexSession,
  indexing,
  onErrorClick,
}: {
  session: Session;
  active: boolean;
  onClick: () => void;
  onIndexSession?: (sessionId: string) => void;
  indexing?: boolean;
  onErrorClick?: (sessionId: string) => void;
}) {
  const harnessColor = HARNESS_COLORS[session.harness] ?? 'var(--mute-strong)';
  const idShort = session.session_id.slice(0, 8);
  const title = session.title ?? '(untitled session)';
  const indexed = session.indexed !== false;
  const stateLabel = session.index_state && session.index_state !== 'hot' ? session.index_state.replace('_', ' ') : null;
  return (
    <button
      className="tb-sess"
      data-active={active ? '1' : '0'}
      data-indexed={indexed ? '1' : '0'}
      onClick={() => {
        if (indexed) onClick();
      }}
    >
      <div className="tb-sess-top">
        <span className="tb-sess-harness" style={{ background: harnessColor }} />
        <span className="tb-sess-id">{idShort}</span>
        {stateLabel && <span className={`tb-sess-state tb-sess-state-${session.index_state}`}>{stateLabel}</span>}
        <span className="tb-sess-time">{localTime(session.started_at)}</span>
      </div>
      <div className="tb-sess-title">{title}</div>
      <div className="tb-sess-bottom">
        <span className="tb-sess-project">{projectName(session.project_path)}</span>
        <span className="tb-sess-stats">
          {indexed ? (
            <>
              <span>{formatDuration(session.aggregates.duration_ms)}</span>
              <span className="tb-sess-dot" />
              <span>{session.aggregates.tool_call_count} calls</span>
              <span className="tb-sess-dot" />
              <span>{formatCost(session.aggregates.total_cost_usd)}</span>
            </>
          ) : (
            <>
              <span>{formatSourceSize(session.source_size)}</span>
              <span className="tb-sess-dot" />
              <span>{session.error_message ?? 'not indexed yet'}</span>
              {onIndexSession && session.index_state !== 'indexing' && (
                <>
                  <span className="tb-sess-dot" />
                  <button
                    type="button"
                    className="tb-sess-index-btn"
                    disabled={indexing}
                    onClick={(e) => {
                      e.stopPropagation();
                      onIndexSession(session.session_id);
                    }}
                  >
                    {indexing ? 'Indexing…' : 'Index'}
                  </button>
                </>
              )}
            </>
          )}
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

function formatSourceSize(bytes: number | undefined): string {
  if (bytes == null || bytes <= 0) return 'source only';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
