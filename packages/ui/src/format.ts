// Small formatters shared across components.

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s`;
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

/** Compact token count: 1_500 → "1.5k", 2_350_000 → "2.4M". */
export function formatTokensCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

export function formatCost(usd: number | null | undefined): string {
  if (usd == null) return '$0.00';
  if (usd >= 100) return '$' + usd.toFixed(0);
  if (usd >= 10) return '$' + usd.toFixed(2);
  return '$' + usd.toFixed(usd < 0.01 ? 4 : 2);
}

export function projectName(path: string): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function localTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso.slice(11, 16);
  }
}

export function localTimeWithSec(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso.slice(11, 19);
  }
}
