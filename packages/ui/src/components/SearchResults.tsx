import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Harness, SearchEventsResult, SearchResultGroup } from '../types';
import { searchEvents } from '../api';
import { HARNESS_LABELS, HARNESS_COLORS } from '../constants';
import { projectName } from '../format';
import { parseSnippet, resumeCommand } from '../searchHelpers';

interface Props {
  query: string;
  harness: Harness | 'all';
  /** Open a result: select its session and jump to the matching event. */
  onOpenResult: (sessionId: string, eventId: string) => void;
}

const DEBOUNCE_MS = 300;
const SLOW_MS = 2000;

export function SearchResults({ query, harness, onOpenResult }: Props) {
  const [data, setData] = useState<SearchEventsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (!q) {
      setData(null);
      setLoading(false);
      setError(null);
      setSlow(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const slowTimer = setTimeout(() => !cancelled && setSlow(true), SLOW_MS);
    const debounce = setTimeout(() => {
      searchEvents({ q, harness })
        .then((r) => !cancelled && setData(r)) // retain prior results until the new ones land
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
          setSlow(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearTimeout(slowTimer);
    };
  }, [q, harness]);

  if (!q) {
    return (
      <section className="tb-search-surface">
        <div className="tb-search-idle">
          <p>Search message content, thinking, tool inputs, outputs, and errors across all sessions.</p>
          <p className="tb-search-idle-hint">
            Type a query above and press <kbd>Enter</kbd>. <kbd>Esc</kbd> returns to the timeline.
          </p>
        </div>
      </section>
    );
  }

  const results = data?.results ?? [];
  const total = data?.total ?? 0;

  return (
    <section className="tb-search-surface">
      <div className="tb-search-status">
        <span>
          {loading && !data
            ? `Searching “${q}”…`
            : `${total} session${total === 1 ? '' : 's'} match “${q}”`}
        </span>
        {loading && data ? <span className="tb-search-spinner" aria-label="searching" /> : null}
        {slow ? <span className="tb-search-slow">taking longer than usual…</span> : null}
        {data && !data.semanticAvailable ? (
          <span className="tb-search-lexnote" title="Semantic search is not enabled on this install — results are lexical only.">
            lexical-only
          </span>
        ) : null}
      </div>

      {error ? <div className="tb-empty">Error: {error}</div> : null}
      {!error && !loading && results.length === 0 ? (
        <div className="tb-empty">No results for “{q}”.</div>
      ) : null}

      <ul className="tb-search-results">
        {results.map((g) => (
          <ResultCard key={g.session.session_id} group={g} onOpenResult={onOpenResult} />
        ))}
      </ul>
    </section>
  );
}

function ResultCard({
  group,
  onOpenResult,
}: {
  group: SearchResultGroup;
  onOpenResult: (sessionId: string, eventId: string) => void;
}) {
  const s = group.session;
  const [copied, setCopied] = useState(false);
  const resume = resumeCommand(s.harness, s.session_id);
  const open = () => onOpenResult(s.session_id, group.matches[0]?.event_id ?? '');

  const copyResume = (e: MouseEvent) => {
    e.stopPropagation();
    if (!resume) return;
    void navigator.clipboard?.writeText(resume);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <li className="tb-search-result" onClick={open} role="button" tabIndex={0}>
      <div className="tb-search-result-head">
        <span
          className="tb-harness-badge"
          style={{ '--badge': HARNESS_COLORS[s.harness] } as CSSProperties}
        >
          {HARNESS_LABELS[s.harness]}
        </span>
        <span className="tb-search-result-title">{s.title ?? projectName(s.project_path)}</span>
        <span className="tb-search-result-meta">
          {projectName(s.project_path)} · {new Date(s.started_at).toLocaleDateString()}
        </span>
      </div>
      <div className="tb-search-snippets">
        {group.matches.map((m) => (
          <p key={m.chunk_id} className="tb-search-snippet">
            {m.source === 'semantic' ? (
              <span className="tb-match-kind" title="semantic match">≈ </span>
            ) : null}
            {parseSnippet(m.snippet).map((seg, i) =>
              seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
            )}
          </p>
        ))}
      </div>
      {resume ? (
        <div className="tb-search-result-actions">
          <button type="button" className="tb-resume-btn" onClick={copyResume} title="Copy resume command">
            {copied ? 'Copied ✓' : `Resume · ${resume}`}
          </button>
        </div>
      ) : null}
    </li>
  );
}
