import { useMemo } from 'react';
import type { Harness, Session } from '../types';
import { projectName } from '../format';

interface HarnessAggregate {
  harness: Harness;
  label: string;
  totalCostUsd: number;
  sessionCount: number;
  totalTurns: number;
  totalToolCalls: number;
  pct: number;
}

interface ProjectAggregate {
  project: string;
  totalCostUsd: number;
  sessionCount: number;
}

export interface SpendAggregates {
  grand: {
    totalCostUsd: number;
    totalSessions: number;
    totalTurns: number;
    totalToolCalls: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheCreationTokens: number;
  };
  byHarness: HarnessAggregate[];
  byProject: ProjectAggregate[];
}

const HARNESS_LABELS: Record<Harness, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
};

export function useSpendAggregates(sessions: Session[]): SpendAggregates {
  return useMemo(() => {
    const grand = {
      totalCostUsd: 0,
      totalSessions: sessions.length,
      totalTurns: 0,
      totalToolCalls: 0,
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    };

    const harnessMap = new Map<Harness, Omit<HarnessAggregate, 'pct'>>();
    const projectMap = new Map<string, ProjectAggregate>();

    for (const session of sessions) {
      const agg = session.aggregates;

      // Accumulate grand totals
      grand.totalCostUsd += agg.total_cost_usd;
      grand.totalTurns += agg.turn_count;
      grand.totalToolCalls += agg.tool_call_count;
      grand.totalDurationMs += agg.duration_ms;
      grand.totalInputTokens += agg.total_input_tokens;
      grand.totalOutputTokens += agg.total_output_tokens;
      grand.totalCacheReadTokens += agg.total_cache_read_tokens;
      grand.totalCacheCreationTokens += agg.total_cache_creation_tokens;

      // Accumulate by harness
      const h = harnessMap.get(session.harness) ?? {
        harness: session.harness,
        label: HARNESS_LABELS[session.harness] ?? session.harness,
        totalCostUsd: 0,
        sessionCount: 0,
        totalTurns: 0,
        totalToolCalls: 0,
      };
      h.totalCostUsd += agg.total_cost_usd;
      h.sessionCount += 1;
      h.totalTurns += agg.turn_count;
      h.totalToolCalls += agg.tool_call_count;
      harnessMap.set(session.harness, h);

      // Accumulate by project
      const projName = projectName(session.project_path);
      const p = projectMap.get(projName) ?? {
        project: projName,
        totalCostUsd: 0,
        sessionCount: 0,
      };
      p.totalCostUsd += agg.total_cost_usd;
      p.sessionCount += 1;
      projectMap.set(projName, p);
    }

    // Convert harness map to array with percentages, sorted by cost descending
    const byHarness = Array.from(harnessMap.values())
      .map((h) => ({
        ...h,
        pct: grand.totalCostUsd > 0 ? (h.totalCostUsd / grand.totalCostUsd) * 100 : 0,
      }))
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    // Sort projects by spend descending, take top 10
    const byProject = Array.from(projectMap.values())
      .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
      .slice(0, 10);

    return { grand, byHarness, byProject };
  }, [sessions]);
}
