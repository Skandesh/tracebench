import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Harness, Session, ToolCount, Turn } from './types';
import { listSessions, getSession, getSessionTurns } from './api';
import { projectName } from './format';
import { useErrorNavigation } from './hooks/useErrorNavigation';
import { useSessionsPaneCollapsed } from './hooks/useSessionsPaneCollapsed';
import { TopBar } from './components/TopBar';
import { SessionList } from './components/SessionList';
import { Timeline } from './components/Timeline';
import { AnalyticsRail } from './components/AnalyticsRail';
import { SpendDashboard } from './components/SpendDashboard';

type ViewMode = 'timeline' | 'dashboard';

interface SessionDetailBundle {
  session: Session;
  toolCounts: ToolCount[];
  turns: Turn[];
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [toolCounts, setToolCounts] = useState<ToolCount[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [search, setSearch] = useState('');
  const [filterHarness, setFilterHarness] = useState<Harness | 'all'>('all');
  const [filterProject, setFilterProject] = useState<string | null>(null);
  const [filterTool, setFilterTool] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('timeline');

  // All error-navigation mechanics — finding errored tool_calls, cycling the
  // active one, scrolling to it, and resolving the cross-session "switch +
  // jump" intent — live in this hook. App just decides when to invoke it.
  const errNav = useErrorNavigation({ turns, activeId, detailLoading, setActiveId });
  const { collapsed: sessionsCollapsed, toggle: toggleSessionsPane } = useSessionsPaneCollapsed();

  // One initial fetch of *all* sessions, no harness filter. Filter + search
  // happen in-memory below so switching tabs is instant and tab counts are
  // always accurate.
  const refresh = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const { sessions: rows } = await listSessions();
      setSessions(rows);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sessionsForProjects = useMemo(() => {
    return sessions.filter((s) => {
      if (filterHarness !== 'all' && s.harness !== filterHarness) return false;
      return true;
    });
  }, [sessions, filterHarness]);

  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessionsForProjects.filter((s) => {
      if (filterProject != null && projectName(s.project_path) !== filterProject) {
        return false;
      }
      if (!q) return true;
      return (
        s.session_id.toLowerCase().includes(q) ||
        s.project_path.toLowerCase().includes(q) ||
        (s.title?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [sessionsForProjects, filterProject, search]);

  useEffect(() => {
    if (filterProject == null) return;
    const stillVisible = sessionsForProjects.some(
      (s) => projectName(s.project_path) === filterProject,
    );
    if (!stillVisible) setFilterProject(null);
  }, [sessionsForProjects, filterProject]);

  // Auto-select a sensible active session when the visible list changes:
  //   - if the current active is still visible, keep it
  //   - otherwise pick the first visible session (newest first)
  //   - if nothing is visible, clear the selection
  useEffect(() => {
    setActiveId((cur) => {
      if (cur && filteredSessions.some((s) => s.session_id === cur)) return cur;
      return filteredSessions[0]?.session_id ?? null;
    });
  }, [filteredSessions]);

  // Fetch detail + turns when active session changes
  // In-memory cache: session_id → { session, toolCounts, turns }. Re-visiting
  // a session you've already loaded is instant. Held in a ref so it doesn't
  // trigger re-renders when populated.
  const detailCacheRef = useRef<Map<string, SessionDetailBundle>>(new Map());

  useEffect(() => {
    if (!activeId) {
      setActiveSession(null);
      setToolCounts([]);
      setTurns([]);
      return;
    }
    const cached = detailCacheRef.current.get(activeId);
    if (cached) {
      // Cache hit — paint immediately, no spinner, no network.
      setActiveSession(cached.session);
      setToolCounts(cached.toolCounts);
      setTurns(cached.turns);
      setFilterTool(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([getSession(activeId), getSessionTurns(activeId)])
      .then(([detail, t]) => {
        if (cancelled) return;
        const bundle: SessionDetailBundle = {
          session: detail.session,
          toolCounts: detail.tool_counts,
          turns: t.turns,
        };
        detailCacheRef.current.set(activeId, bundle);
        setActiveSession(bundle.session);
        setToolCounts(bundle.toolCounts);
        setTurns(bundle.turns);
        setFilterTool(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setSessionsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeId]);

  // Keyboard nav: j/k navigate sessions, / focuses search, Esc blurs input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') (target as HTMLInputElement).blur();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('tb-search')?.focus();
        return;
      }
      if (e.key === 'd') {
        e.preventDefault();
        setView((v) => (v === 'dashboard' ? 'timeline' : 'dashboard'));
        return;
      }
      if (!filteredSessions.length) return;
      const i = filteredSessions.findIndex((s) => s.session_id === activeId);
      if (e.key === 'j' && i >= 0 && i < filteredSessions.length - 1) setActiveId(filteredSessions[i + 1]!.session_id);
      if (e.key === 'k' && i > 0) setActiveId(filteredSessions[i - 1]!.session_id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filteredSessions, activeId]);

  return (
    <div className="tb-app" data-sessions-collapsed={sessionsCollapsed ? '1' : '0'}>
      <TopBar
        search={search}
        setSearch={setSearch}
        filterHarness={filterHarness}
        setFilterHarness={setFilterHarness}
        sessions={sessions}
        view={view}
        setView={setView}
      />
      {view === 'dashboard' ? (
        <SpendDashboard sessions={sessions} onClose={() => setView('timeline')} />
      ) : (
        <div className="tb-cols">
          <SessionList
            sessions={filteredSessions}
            sessionsForProjects={sessionsForProjects}
            filterProject={filterProject}
            setFilterProject={setFilterProject}
            activeId={activeId}
            setActiveId={setActiveId}
            onErrorClick={errNav.navigateForSession}
            collapsed={sessionsCollapsed}
            onToggleCollapsed={toggleSessionsPane}
          />
          {sessionsError ? (
            <section className="tb-pane tb-pane-center"><div className="tb-empty">Error: {sessionsError}</div></section>
          ) : activeSession ? (
            <Timeline
              session={activeSession}
              turns={turns}
              loading={detailLoading}
              filterTool={filterTool}
              setFilterTool={setFilterTool}
              timelineRef={errNav.timelineRef}
              errorEventIds={errNav.errorEventIds}
              activeErrorIndex={errNav.activeErrorIndex}
              onErrorClick={errNav.navigateNext}
              onClearErrorHighlight={errNav.clearHighlight}
            />
          ) : sessionsLoading ? (
            <section className="tb-pane tb-pane-center"><div className="tb-empty">Loading…</div></section>
          ) : (
            <section className="tb-pane tb-pane-center"><div className="tb-empty">No session selected.</div></section>
          )}
          {activeSession ? (
            <AnalyticsRail session={activeSession} toolCounts={toolCounts} turns={turns} />
          ) : (
            <aside className="tb-pane tb-pane-right"><div className="tb-pane-head"><span>Analytics</span></div></aside>
          )}
        </div>
      )}
    </div>
  );
}
