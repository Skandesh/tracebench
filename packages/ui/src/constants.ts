// Shared constants across UI components.

import type { Harness } from './types';

/** Human-readable labels for each harness/provider. */
export const HARNESS_LABELS: Record<Harness, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
};

/** CSS variable colors for each harness/provider. */
export const HARNESS_COLORS: Record<Harness, string> = {
  claude_code: 'var(--harness-cc)',
  codex: 'var(--harness-cx)',
  opencode: 'var(--harness-ad)',
  cursor: 'var(--harness-cu)',
};
