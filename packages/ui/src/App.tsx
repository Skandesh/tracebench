import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiscoveredSession, Harness, Session, StorageReport, ToolCount, Turn, ViewMode } from './types';
import {
  listSessions,
  getSession,
  getSessionTurns,
  listDiscoveredSessions,
  getStorageReport,
  indexSession,
  reindex,
} from './api';
import { projectName } from './format';
import { useErrorNavigation } from './hooks/useErrorNavigation';
import { useTimelineJump } from './hooks/useTimelineJump';
import { useSessionsPaneCollapsed } from './hooks/useSessionsPaneCollapsed';
import { TopBar } from './components/TopBar';
import { SessionList } from './components/SessionList';
import { Timeline } from './components/Timeline';
import { AnalyticsRail } from './components/AnalyticsRail';
import { SpendDashboard } from './components/SpendDashboard';
import { SearchResults } from './components/SearchResults';

interface SessionDetailBundle {
  session: Session;
  toolCounts: ToolCount[];
  turns: Turn[];
}

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredSession[]>([]);
  const [storage, setStorage] = useState<StorageReport | null>(null);
  const [indexingId, setIndexingId] = useState<string | null>(null);
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
  const timelineRef = useRef<HTMLDivElement>(null);
  const errNav = useErrorNavigation({
    turns,
    activeId,
    detailLoading,
    setActiveId,
    timelineRef,
  });
  const inspectorJump = useTimelineJump(activeId, timelineRef);
  const { collapsed: sessionsCollapsed, toggle: toggleSessionsPane } = useSessionsPaneCollapsed();
  // A jump queued by clicking a search result, consumed once the target
  // session's turns have loaded (the timeline element must exist to scroll to).
  const pendingJumpRef = useRef<{ sessionId: string; eventId: string } | null>(null);

  // One initial fetch of *all* sessions, no harness filter. Filter + search
  // happen in-memory below so switching tabs is instant and tab counts are
  // always accurate.
  const refresh = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const [{ sessions: rows }, { sessions: manifest }, storageReport] = await Promise.all([
        listSessions(),
        listDiscoveredSessions(),
        getStorageReport(),
      ]);
      setSessions(rows);
      setDiscovered(manifest);
      setStorage(storageReport);
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleSessions = useMemo(
    () => mergeIndexedAndDiscoveredSessions(sessions, discovered),
    [sessions, discovered],
  );

  const sessionsForProjects = useMemo(() => {
    return visibleSessions.filter((s) => {
      if (filterHarness !== 'all' && s.harness !== filterHarness) return false;
      return true;
    });
  }, [visibleSessions, filterHarness]);

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
      if (cur && filteredSessions.some((s) => s.session_id === cur && isIndexedSession(s))) return cur;
      return filteredSessions.find(isIndexedSession)?.session_id ?? null;
    });
  }, [filteredSessions]);

  const handleIndexSession = useCallback(
    async (id: string) => {
      setIndexingId(id);
      setSessionsError(null);
      try {
        await indexSession(id);
        detailCacheRef.current.delete(id);
        await refresh();
        setActiveId(id);
      } catch (e) {
        setSessionsError(e instanceof Error ? e.message : String(e));
      } finally {
        setIndexingId(null);
      }
    },
    [refresh],
  );

  const handleReindex = useCallback(async () => {
    setIndexingId('*');
    setSessionsError(null);
    try {
      await reindex();
      detailCacheRef.current.clear();
      await refresh();
    } catch (e) {
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setIndexingId(null);
    }
  }, [refresh]);

  // Open a search result: select its session, switch to the timeline, and queue
  // a jump to the matching event (consumed after detail loads). Separate surface
  // — the client-side session-list filter (filteredSessions) is untouched.
  const handleOpenResult = useCallback((sessionId: string, eventId: string) => {
    pendingJumpRef.current = eventId ? { sessionId, eventId } : null;
    setActiveId(sessionId);
    setView('timeline');
  }, []);

  // Enter in the search box escalates from list-filtering to full-text search.
  const handleSubmitSearch = useCallback(() => {
    setView((v) => (search.trim() ? 'search' : v));
  }, [search]);

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

  // Consume a queued search-result jump once the target session's turns load.
  useEffect(() => {
    const pj = pendingJumpRef.current;
    if (pj && pj.sessionId === activeId && turns.length > 0) {
      inspectorJump.jumpToEvent(pj.eventId);
      pendingJumpRef.current = null;
    }
  }, [turns, activeId, inspectorJump]);

  // Keyboard nav: j/k navigate sessions, / focuses search, Esc blurs input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') {
          (target as HTMLInputElement).blur();
          if (view === 'search') setView('timeline');
        }
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
      const indexedSessions = filteredSessions.filter(isIndexedSession);
      if (!indexedSessions.length) return;
      const i = indexedSessions.findIndex((s) => s.session_id === activeId);
      if (e.key === 'j' && i >= 0 && i < indexedSessions.length - 1) {
        setActiveId(indexedSessions[i + 1]!.session_id);
      }
      if (e.key === 'k' && i > 0) setActiveId(indexedSessions[i - 1]!.session_id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filteredSessions, activeId, view]);

  return (
    <div className="tb-app" data-sessions-collapsed={sessionsCollapsed ? '1' : '0'}>
      <TopBar
        search={search}
        setSearch={setSearch}
        filterHarness={filterHarness}
        setFilterHarness={setFilterHarness}
        sessions={visibleSessions}
        view={view}
        setView={setView}
        onSubmitSearch={handleSubmitSearch}
      />
      <StorageStrip
        storage={storage}
        discovered={discovered.length}
        indexed={sessions.length}
        indexing={indexingId === '*'}
        onReindex={handleReindex}
      />
      {view === 'dashboard' ? (
        <SpendDashboard sessions={sessions} onClose={() => setView('timeline')} />
      ) : view === 'search' ? (
        <SearchResults query={search} harness={filterHarness} onOpenResult={handleOpenResult} />
      ) : (
        <div className="tb-cols">
          <SessionList
            sessions={filteredSessions}
            sessionsForProjects={sessionsForProjects}
            filterProject={filterProject}
            setFilterProject={setFilterProject}
            activeId={activeId}
            setActiveId={setActiveId}
            onIndexSession={handleIndexSession}
            indexingId={indexingId}
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
              timelineRef={timelineRef}
              errorEventIds={errNav.errorEventIds}
              activeErrorIndex={errNav.activeErrorIndex}
              onErrorClick={errNav.navigateNext}
              onClearErrorHighlight={errNav.clearHighlight}
              inspectorHighlightId={inspectorJump.highlightedEventId}
              onClearInspectorHighlight={inspectorJump.clearHighlight}
            />
          ) : sessionsLoading ? (
            <section className="tb-pane tb-pane-center"><div className="tb-empty">Loading…</div></section>
          ) : (
            <section className="tb-pane tb-pane-center"><div className="tb-empty">No session selected.</div></section>
          )}
          {activeSession ? (
            <AnalyticsRail
              session={activeSession}
              toolCounts={toolCounts}
              turns={turns}
              onJumpToEvent={inspectorJump.jumpToEvent}
            />
          ) : (
            <aside className="tb-pane tb-pane-right"><div className="tb-pane-head"><span>Analytics</span></div></aside>
          )}
        </div>
      )}
    </div>
  );
}

function isIndexedSession(s: Session): boolean {
  return s.indexed !== false;
}

// Discovered-only sessions have no parsed cwd yet, so they fall back to the raw
// JSONL path — which makes the Projects sidebar show "<uuid>.jsonl". Claude Code
// and Cursor store sessions under `…/projects/<encoded-cwd>/…`, where the cwd is
// encoded with '/' → '-'. Decode that segment so discovered-only sessions show
// (and group by) their real project. Best-effort: the encoding is lossy for
// project dirs that contain '-', but it's a far better hint than a UUID, and
// indexed sessions always use the authoritative cwd. Harnesses without a
// project segment (e.g. Codex date dirs) keep the raw path.
function discoveredProjectPath(rawPath: string): string {
  const parts = rawPath.split('/').filter(Boolean);
  const i = parts.lastIndexOf('projects');
  const encoded = i >= 0 ? parts[i + 1] : undefined;
  if (encoded) return encoded.replace(/-/g, '/');
  return rawPath;
}

function mergeIndexedAndDiscoveredSessions(
  indexed: Session[],
  discovered: DiscoveredSession[],
): Session[] {
  const manifestByKey = new Map(discovered.map((d) => [`${d.harness}\0${d.raw_path}`, d]));
  const out = indexed.map((s) => {
    const manifest = manifestByKey.get(`${s.harness}\0${s.raw_path}`);
    if (!manifest) return { ...s, indexed: true, index_state: s.index_state ?? 'hot' } as Session;
    return {
      ...s,
      indexed: true,
      index_state: manifest.index_state,
      source_size: manifest.source_size,
      indexed_at: manifest.indexed_at,
      error_message: manifest.error_message,
    };
  });
  const indexedKeys = new Set(indexed.map((s) => `${s.harness}\0${s.raw_path}`));
  for (const d of discovered) {
    const key = `${d.harness}\0${d.raw_path}`;
    if (indexedKeys.has(key)) continue;
    const startedAt = new Date(d.mtime_ms).toISOString();
    out.push({
      session_id: d.session_id,
      harness: d.harness,
      project_path: discoveredProjectPath(d.raw_path),
      title: null,
      started_at: startedAt,
      ended_at: null,
      model: null,
      raw_path: d.raw_path,
      format_version: d.format_version,
      mtime_ms: d.mtime_ms,
      index_state: d.index_state,
      source_size: d.source_size,
      indexed_at: d.indexed_at,
      error_message: d.error_message,
      indexed: false,
      aggregates: {
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        duration_ms: 0,
        turn_count: 0,
        tool_call_count: 0,
        tool_error_count: 0,
        message_count: 0,
        files_touched: [],
        models_used: [],
      },
    });
  }
  out.sort((a, b) => b.mtime_ms - a.mtime_ms || b.started_at.localeCompare(a.started_at));
  return out;
}

function StorageStrip({
  storage,
  discovered,
  indexed,
  indexing,
  onReindex,
}: {
  storage: StorageReport | null;
  discovered: number;
  indexed: number;
  indexing: boolean;
  onReindex: () => void;
}) {
  const deferred = Math.max(0, discovered - indexed);
  const payloads = storage?.payload_bytes.external_payload_count ?? 0;
  return (
    <div className="tb-storage-strip">
      <span>{indexed} indexed</span>
      <span>{deferred} discovered-only</span>
      <span>{payloads} archived payloads</span>
      <button type="button" onClick={onReindex} disabled={indexing}>
        {indexing ? 'Indexing…' : 'Refresh index'}
      </button>
    </div>
  );
}
