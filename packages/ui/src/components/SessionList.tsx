import type { Session, Harness } from '../types';
import { Icons } from '../icons';
import { formatCost, formatDuration, projectName, localTime } from '../format';

interface Props {
  sessions: Session[];
  activeId: string | null;
  setActiveId: (id: string) => void;
}

const HARNESS_COLOR: Record<Harness, string> = {
  claude_code: 'var(--harness-cc)',
  opencode: 'var(--harness-ad)',
  codex: 'var(--harness-cx)',
  cursor: 'var(--mute-strong)',
};

export function SessionList({ sessions, activeId, setActiveId }: Props) {
  // Group projects for the header by last-active.
  const projects: { name: string; count: number; lastActive: string }[] = [];
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
  for (const [name, info] of byProject) projects.push({ name, count: info.count, lastActive: info.latest });
  projects.sort((a, b) => b.lastActive.localeCompare(a.lastActive));

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
}: {
  session: Session;
  active: boolean;
  onClick: () => void;
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
        </span>
      </div>
      {session.aggregates.tool_error_count > 0 && (
        <span className="tb-sess-flag">{session.aggregates.tool_error_count} errors</span>
      )}
    </button>
  );
}
