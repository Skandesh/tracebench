import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Harness, Session, ToolCount, Turn } from './types';
import { listSessions, getSession, getSessionTurns } from './api';
import { useErrorNavigation } from './hooks/useErrorNavigation';
import { TopBar } from './components/TopBar';
import { SessionList } from './components/SessionList';
import { Timeline } from './components/Timeline';
import { AnalyticsRail } from './components/AnalyticsRail';

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
  const [filterTool, setFilterTool] = useState<string | null>(null);

  // All error-navigation mechanics — finding errored tool_calls, cycling the
  // active one, scrolling to it, and resolving the cross-session "switch +
  // jump" intent — live in this hook. App just decides when to invoke it.
  const errNav = useErrorNavigation({ turns, activeId, detailLoading, setActiveId });

  const refresh = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const { sessions: rows } = await listSessions({ harness: filterHarness, q: search || undefined });
      setSessions(rows);
      if (rows.length > 0) {
        setActiveId((cur) => (cur && rows.some((s) => s.session_id === cur) ? cur : rows[0]!.session_id));
      } else {
        setActiveId(null);
      }
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoading(false);
    }
  }, [filterHarness, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch detail + turns when active session changes
  useEffect(() => {
    if (!activeId) {
      setActiveSession(null);
      setToolCounts([]);
      setTurns([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([getSession(activeId), getSessionTurns(activeId)])
      .then(([detail, t]) => {
        if (cancelled) return;
        setActiveSession(detail.session);
        setToolCounts(detail.tool_counts);
        setTurns(t.turns);
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
      if (!sessions.length) return;
      const i = sessions.findIndex((s) => s.session_id === activeId);
      if (e.key === 'j' && i >= 0 && i < sessions.length - 1) setActiveId(sessions[i + 1]!.session_id);
      if (e.key === 'k' && i > 0) setActiveId(sessions[i - 1]!.session_id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, activeId]);

  const filteredSessions = useMemo(() => sessions, [sessions]);

  return (
    <div className="tb-app">
      <TopBar
        search={search}
        setSearch={setSearch}
        filterHarness={filterHarness}
        setFilterHarness={setFilterHarness}
        sessions={sessions}
      />
      <div className="tb-cols">
        <SessionList
          sessions={filteredSessions}
          activeId={activeId}
          setActiveId={setActiveId}
          onErrorClick={errNav.navigateForSession}
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
    </div>
  );
}
