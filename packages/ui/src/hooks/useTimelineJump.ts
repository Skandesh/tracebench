import { useCallback, useEffect, useRef, useState } from 'react';

const SCROLL_RETRY_FRAMES = 10;

export interface TimelineJump {
  highlightedEventId: string | null;
  jumpToEvent: (eventId: string) => void;
  clearHighlight: () => void;
}

export function useTimelineJump(
  activeId: string | null,
  timelineRef: React.RefObject<HTMLDivElement | null>,
): TimelineJump {
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);

  useEffect(() => {
    setHighlightedEventId(null);
  }, [activeId]);

  const jumpToEvent = useCallback((eventId: string) => {
    setHighlightedEventId(eventId);
  }, []);

  const clearHighlight = useCallback(() => {
    setHighlightedEventId(null);
  }, []);

  useEffect(() => {
    if (!highlightedEventId) return;
    let cancelled = false;
    let attempts = 0;
    const tryScroll = () => {
      if (cancelled) return;
      const el = timelineRef.current?.querySelector(
        `[data-event-id="${highlightedEventId}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (attempts++ < SCROLL_RETRY_FRAMES) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
    return () => { cancelled = true; };
  }, [highlightedEventId]);

  useEffect(() => {
    if (!highlightedEventId) return;
    const timer = setTimeout(() => setHighlightedEventId(null), 1200);
    return () => clearTimeout(timer);
  }, [highlightedEventId]);

  return { highlightedEventId, jumpToEvent, clearHighlight };
}
