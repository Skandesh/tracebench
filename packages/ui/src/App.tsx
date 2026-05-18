import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import type { Harness, Session, ToolCount, Turn } from './types';
import { listSessions, getSession, getSessionTurns } from './api';
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

  // Error navigation state
  const [activeErrorIndex, setActiveErrorIndex] = useState<number | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  // Computed list of event IDs with errors. Two-pass per turn (index
  // tool_results by parent first, then walk tool_calls) so total work is
  // O(events) not O(events²).
  const errorEventIds = useMemo(() => {
    const ids: string[] = [];
    for (const turn of turns) {
      const resultByCallId = new Map<string, (typeof turn.events)[number]>();
      for (const e of turn.events) {
        if (e.event_type === 'tool_result' && e.parent_event_id) {
          resultByCallId.set(e.parent_event_id, e);
        }
      }
      for (const e of turn.events) {
        if (
          e.event_type === 'tool_call' &&
          resultByCallId.get(e.event_id)?.tool.status === 'error'
        ) {
          ids.push(e.event_id);
        }
      }
    }
    return ids;
  }, [turns]);

  // Handler to navigate to next error (cycles through all errors)
  const navigateToNextError = useCallback(() => {
    if (errorEventIds.length === 0) return;
    setActiveErrorIndex((prev) =>
      prev === null ? 0 : (prev + 1) % errorEventIds.length
    );
  }, [errorEventIds]);

  // Handler to navigate to first error
  const navigateToFirstError = useCallback(() => {
    if (errorEventIds.length === 0) return;
    setActiveErrorIndex(0);
  }, [errorEventIds]);

  // Clear highlight handler
  const clearErrorHighlight = useCallback(() => {
    setActiveErrorIndex(null);
  }, []);

  // "Click N err on any session card" intent. If it's the active session we
  // can navigate immediately; otherwise switch sessions first and queue the
  // navigation until turns finish loading (consumed below).
  const [pendingErrorNavSession, setPendingErrorNavSession] = useState<string | null>(null);
  const handleSessionErrorClick = useCallback(
    (sessionId: string) => {
      if (sessionId === activeId) {
        navigateToFirstError();
        return;
      }
      setActiveId(sessionId);
      setPendingErrorNavSession(sessionId);
    },
    [activeId, navigateToFirstError],
  );

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
    setActiveErrorIndex(null); // Reset error navigation on session change
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

  // Consume pending "switch + jump" intent once turns load for the queued session.
  useEffect(() => {
    if (!pendingErrorNavSession) return;
    if (pendingErrorNavSession !== activeId) return;
    if (detailLoading) return;
    if (errorEventIds.length === 0) {
      // Session has no errors after all — drop the intent.
      setPendingErrorNavSession(null);
      return;
    }
    setActiveErrorIndex(0);
    setPendingErrorNavSession(null);
  }, [pendingErrorNavSession, activeId, detailLoading, errorEventIds]);

  // Scroll to active error when index changes. The target element may not
  // exist on the first paint after a session switch — retry on the next frame
  // until it does or we give up.
  useEffect(() => {
    if (activeErrorIndex === null || errorEventIds.length === 0) return;
    const targetEventId = errorEventIds[activeErrorIndex];
    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const el = timelineRef.current?.querySelector(
        `[data-event-id="${targetEventId}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (attempts++ < 10) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
    return () => { cancelled = true; };
  }, [activeErrorIndex, errorEventIds]);

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
          onErrorClick={handleSessionErrorClick}
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
            timelineRef={timelineRef}
            errorEventIds={errorEventIds}
            activeErrorIndex={activeErrorIndex}
            onErrorClick={navigateToNextError}
            onClearErrorHighlight={clearErrorHighlight}
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
