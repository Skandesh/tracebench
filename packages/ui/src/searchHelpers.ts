// Pure helpers for the search surface. Kept separate from the component so they
// are unit-testable and have no React/DOM dependency.

import type { Harness } from './types';

// Must match the sentinels the backend (core/search.ts) wraps matched spans in.
export const SNIPPET_OPEN = '\u0001';
export const SNIPPET_CLOSE = '\u0002';

export interface SnippetSegment {
  text: string;
  match: boolean;
}

/**
 * Split a sentinel-delimited snippet into plain/match segments so the UI can
 * render matches as <mark> TEXT NODES — never via dangerouslySetInnerHTML, so
 * a tool output containing markup (or `<script>`) can't inject anything.
 */
export function parseSnippet(s: string): SnippetSegment[] {
  const segs: SnippetSegment[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf(SNIPPET_OPEN, i);
    if (open === -1) {
      segs.push({ text: s.slice(i), match: false });
      break;
    }
    if (open > i) segs.push({ text: s.slice(i, open), match: false });
    const close = s.indexOf(SNIPPET_CLOSE, open + 1);
    if (close === -1) {
      segs.push({ text: s.slice(open + 1), match: true });
      break;
    }
    segs.push({ text: s.slice(open + 1, close), match: true });
    i = close + 1;
  }
  return segs.filter((seg) => seg.text.length > 0);
}

/**
 * The harness-native command to resume a session. tracebench is a viewer, not a
 * harness, so it surfaces the command for the user to run rather than resuming
 * the agent itself. Cursor exposes no CLI resume → null (reopen in the app).
 */
export function resumeCommand(harness: Harness, sessionId: string): string | null {
  switch (harness) {
    case 'claude_code':
      return `claude --resume ${sessionId}`;
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `opencode --session ${sessionId}`;
    case 'cursor':
      return null;
    default:
      return null;
  }
}
