import { useMemo } from 'react';
import type { Harness, Session, ViewMode } from '../types';
import { Icons } from '../icons';
import { HARNESS_LABELS } from '../constants';

interface Props {
  search: string;
  setSearch: (s: string) => void;
  filterHarness: Harness | 'all';
  setFilterHarness: (h: Harness | 'all') => void;
  sessions: Session[];
  view: ViewMode;
  setView: (v: ViewMode) => void;
}

const HARNESSES: { id: Harness | 'all'; label: string; live: boolean }[] = [
  { id: 'all', label: 'All', live: true },
  { id: 'claude_code', label: HARNESS_LABELS.claude_code, live: true },
  { id: 'codex', label: HARNESS_LABELS.codex, live: true },
  { id: 'opencode', label: HARNESS_LABELS.opencode, live: true },
  { id: 'cursor', label: HARNESS_LABELS.cursor, live: true },
];

export function TopBar({ search, setSearch, filterHarness, setFilterHarness, sessions, view, setView }: Props) {
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sessions.length };
    for (const s of sessions) {
      c[s.harness] = (c[s.harness] ?? 0) + 1;
    }
    return c;
  }, [sessions]);

  return (
    <header className="tb-top">
      <div className="tb-brand">
        <div className="tb-logo" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="1.5" y="1.5" width="15" height="15" rx="3.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M4 11.5 7 8l2.5 2.5L14 6" stroke="var(--accent)" strokeWidth="1.6"
                  strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="14" cy="6" r="1.6" fill="var(--accent)" />
          </svg>
        </div>
        <div className="tb-brand-name">tracebench</div>
        <div className="tb-brand-ver">0.1.0-alpha</div>
      </div>

      <div className="tb-search-wrap">
        <span className="tb-search-icon"><Icons.Search size={13} /></span>
        <input
          id="tb-search"
          className="tb-search"
          placeholder="Search sessions, files, commands…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="tb-kbd-hint"><kbd>/</kbd></span>
      </div>

      <div className="tb-top-right">
        <div className="tb-harness-tabs">
          {HARNESSES.map((tab) => (
            <button
              key={tab.id}
              className="tb-harness-tab"
              data-active={filterHarness === tab.id ? '1' : '0'}
              data-disabled={!tab.live ? '1' : '0'}
              disabled={!tab.live}
              title={tab.live ? '' : 'Coming in v0.2'}
              onClick={() => tab.live && setFilterHarness(tab.id)}
            >
              {tab.label}
              <span className="tb-harness-count">{counts[tab.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <span className="tb-divider" />
        <button
          className="tb-icon-btn"
          data-active={view === 'dashboard' ? '1' : '0'}
          onClick={() => setView(view === 'dashboard' ? 'timeline' : 'dashboard')}
          title={view === 'dashboard' ? 'Back to sessions (d)' : 'Spend Dashboard (d)'}
          aria-label={view === 'dashboard' ? 'Close dashboard' : 'Open spend dashboard'}
        >
          <Icons.Chart size={14} />
        </button>
        <span className="tb-status-pill">
          <span className="tb-status-dot" />
          local
        </span>
      </div>
    </header>
  );
}
