// Error-navigation capability for the session timeline.
//
// Owns the HOW of "find the errored tool_calls, scroll to one, highlight it,
// cycle through them, and resolve the cross-session 'switch + jump' intent."
// App.tsx orchestrates the WHEN (which session is active, what should happen
// when a user clicks "N err" on a card) but delegates the mechanics here.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Turn } from '../types';
import { findErrorToolCallIds } from '../selectors';

const SCROLL_RETRY_FRAMES = 10;

export interface ErrorNavigation {
  /** Ref to attach to the scrollable timeline container. */
  timelineRef: React.RefObject<HTMLDivElement | null>;
  /** Event IDs of tool_calls whose tool_result is errored, in document order. */
  errorEventIds: string[];
  /** Currently active error in the cycle, or null when none. */
  activeErrorIndex: number | null;
  /** Move to the next error (wraps around). No-op when there are no errors. */
  navigateNext: () => void;
  /** Move to the first error. No-op when there are no errors. */
  navigateFirst: () => void;
  /** Clear the active error highlight. */
  clearHighlight: () => void;
  /**
   * "Click N err on a session card" intent. If the clicked session is already
   * active, navigate immediately. Otherwise activate it (via setActiveId) and
   * queue the navigation until turns load for that session.
   */
  navigateForSession: (sessionId: string) => void;
}

interface Params {
  /** Current turns of the active session. */
  turns: Turn[];
  /** Active session id. Compared against the click-target to decide queue vs immediate. */
  activeId: string | null;
  /** True while detail/turns for `activeId` are loading — used to gate the queued jump. */
  detailLoading: boolean;
  /** Called by `navigateForSession` to switch sessions when the target isn't active. */
  setActiveId: (id: string) => void;
  /** Shared scroll container for the timeline (also used by context inspector jumps). */
  timelineRef: React.RefObject<HTMLDivElement | null>;
}

export function useErrorNavigation({
  turns,
  activeId,
  detailLoading,
  setActiveId,
  timelineRef,
}: Params): ErrorNavigation {
  const [activeErrorIndex, setActiveErrorIndex] = useState<number | null>(null);
  const [pendingErrorNavSession, setPendingErrorNavSession] = useState<string | null>(null);

  const errorEventIds = useMemo(() => findErrorToolCallIds(turns), [turns]);

  // Clear the active error whenever the active session changes, so a stale
  // highlight from the previous session never bleeds into a new one.
  useEffect(() => {
    setActiveErrorIndex(null);
  }, [activeId]);

  const navigateNext = useCallback(() => {
    if (errorEventIds.length === 0) return;
    setActiveErrorIndex((prev) =>
      prev === null ? 0 : (prev + 1) % errorEventIds.length,
    );
  }, [errorEventIds]);

  const navigateFirst = useCallback(() => {
    if (errorEventIds.length === 0) return;
    setActiveErrorIndex(0);
  }, [errorEventIds]);

  const clearHighlight = useCallback(() => {
    setActiveErrorIndex(null);
  }, []);

  const navigateForSession = useCallback(
    (sessionId: string) => {
      if (sessionId === activeId) {
        navigateFirst();
        return;
      }
      setActiveId(sessionId);
      setPendingErrorNavSession(sessionId);
    },
    [activeId, navigateFirst, setActiveId],
  );

  // Consume the queued switch-and-jump intent once the new session's turns
  // are loaded. If the session turns out to have no errors after all, drop
  // the intent.
  useEffect(() => {
    if (!pendingErrorNavSession) return;
    if (pendingErrorNavSession !== activeId) return;
    if (detailLoading) return;
    if (errorEventIds.length === 0) {
      setPendingErrorNavSession(null);
      return;
    }
    setActiveErrorIndex(0);
    setPendingErrorNavSession(null);
  }, [pendingErrorNavSession, activeId, detailLoading, errorEventIds]);

  // Scroll the timeline to the active error. The target element may not exist
  // on the first paint after a session switch (React is still rendering the
  // new turns), so retry on the next frame until it does or we give up.
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
      if (attempts++ < SCROLL_RETRY_FRAMES) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
    return () => { cancelled = true; };
  }, [activeErrorIndex, errorEventIds]);

  return {
    timelineRef,
    errorEventIds,
    activeErrorIndex,
    navigateNext,
    navigateFirst,
    clearHighlight,
    navigateForSession,
  };
}
