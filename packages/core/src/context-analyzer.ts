// Session-mode context window analyzer (PRD §9.7).
// Pure transforms over canonical turns — no I/O.

import type {
  CanonicalEvent,
  ContextComponent,
  ContextComponentKind,
  ContextSnapshot,
  Harness,
  Turn,
} from './schema.js';
import { computeCost, resolveModel, type PricingTable } from './pricing-calc.js';

const DEFAULT_CONTEXT_MAX = 200_000;
const DEFAULT_VALLEY_THRESHOLD = 2_000;
const CHARS_PER_TOKEN = 4;

/** Typical point where agent frameworks summarize or compact history (~80% of window). */
export const CONTEXT_PRESSURE_THRESHOLD = 0.8;
export const CONTEXT_PRESSURE_CRITICAL = 0.95;

export type ContextPressureLevel = 'ok' | 'elevated' | 'critical';

export function snapshotTokenTotal(snapshot: ContextSnapshot): number {
  return snapshot.components.reduce((sum, c) => sum + c.token_count, 0);
}

export function contextFillRatio(totalTokens: number, maxContextTokens: number): number {
  if (maxContextTokens <= 0) return 0;
  return Math.min(1, totalTokens / maxContextTokens);
}

export function contextPressureLevel(fillRatio: number): ContextPressureLevel {
  if (fillRatio >= CONTEXT_PRESSURE_CRITICAL) return 'critical';
  if (fillRatio >= CONTEXT_PRESSURE_THRESHOLD) return 'elevated';
  return 'ok';
}

const METHODOLOGY_NOTE =
  'Attention zones use a positional heuristic (first 20% primacy, middle 60% valley, last 20% recency) inspired by "lost in the middle" findings (Liu et al., 2023). This is not a direct measurement of model attention.';

export interface AttentionZones {
  primacy_start: number;
  primacy_end: number;
  valley_start: number;
  valley_end: number;
  recency_start: number;
  recency_end: number;
  methodology: string;
}

export type ContextSuggestionKind = 'reorder' | 'trim' | 'compress' | 'cache';

export interface ContextSuggestion {
  kind: ContextSuggestionKind;
  reason: string;
}

export type WasteKind = 'duplicate_tool_call' | 'stale_read';

export interface WasteItem {
  kind: WasteKind;
  description: string;
  source_event_id: string | null;
  related_event_id: string | null;
  estimated_tokens: number;
  estimated_cost_usd: number | null;
}

export interface ValleyFlag {
  turn_id: string;
  component: ContextComponent;
  reason: string;
}

export type ToolResultLogStatus = 'logged' | 'missing' | 'empty' | 'orphan';

export interface ToolResultContextImpact {
  call_event_id: string | null;
  result_event_id: string | null;
  tool_name: string | null;
  label: string;
  turn_id: string;
  turn_index: number;
  estimated_tokens: number;
  /** Running reconstructed context size after this result lands. */
  cumulative_after: number;
  log_status: ToolResultLogStatus;
}

export interface TurnContextDelta {
  turn_id: string;
  turn_index: number;
  delta_tokens: number;
  cumulative_tokens: number;
}

export type MissingLogKind =
  | 'missing_tool_result'
  | 'orphan_tool_result'
  | 'empty_tool_output'
  | 'harness_no_tool_results';

export interface MissingLogItem {
  kind: MissingLogKind;
  description: string;
  call_event_id: string | null;
  result_event_id: string | null;
  turn_id: string;
  turn_index: number;
  tool_name: string | null;
  /** Best event id to scroll to in the timeline. */
  jump_event_id: string | null;
}

export interface SessionContextAnalysis {
  snapshots: ContextSnapshot[];
  maxContextTokens: number;
  /** Reconstructed fill ratio at the latest turn (0–1). */
  fillRatio: number;
  pressureLevel: ContextPressureLevel;
  /** Per-turn reconstructed fill ratio, aligned with `snapshots`. */
  fillRatioByTurn: number[];
  /** Zones based on the latest turn's total context size. */
  attentionZones: AttentionZones;
  valleyFlags: ValleyFlag[];
  wasteItems: WasteItem[];
  suggestions: ContextSuggestion[];
  growthRate: ContextComponentKind | null;
  toolResultImpacts: ToolResultContextImpact[];
  topOffenders: ToolResultContextImpact[];
  turnDeltas: TurnContextDelta[];
  categoryTotals: Partial<Record<ContextComponentKind, number>>;
  missingLogs: MissingLogItem[];
  methodology: string;
}

export interface AnalyzeSessionContextOptions {
  /** Required for cost estimates; pass vendored pricing.json in browser contexts. */
  pricingTable: PricingTable;
  valleyTokenThreshold?: number;
  /** Used to flag harnesses that omit tool results from exported logs. */
  harness?: Harness | null;
  topOffenderLimit?: number;
}

/** Resolve max context tokens from model name and optional pricing table. */
export function guessContextMax(
  model: string | null,
  table?: PricingTable,
): number {
  if (!model) return DEFAULT_CONTEXT_MAX;
  if (/opus-4-7/i.test(model)) return 1_000_000;
  if (table) {
    const resolved = resolveModel(table, model);
    if (resolved) {
      const max = table.models[resolved]?.max_input_tokens;
      if (max != null && max > 0) return max;
    }
  }
  return DEFAULT_CONTEXT_MAX;
}

export function analyzeSessionContext(
  turns: Turn[],
  model: string | null,
  options: AnalyzeSessionContextOptions,
): SessionContextAnalysis {
  const table = options.pricingTable;
  const valleyThreshold = options.valleyTokenThreshold ?? DEFAULT_VALLEY_THRESHOLD;
  const resolvedModel = model ?? turns.find((t) => t.events.some((e) => e.model))?.events.find((e) => e.model)?.model ?? 'unknown';
  const maxContext = guessContextMax(resolvedModel, table);

  const snapshots: ContextSnapshot[] = [];
  for (let i = 0; i < turns.length; i++) {
    snapshots.push(buildSnapshot(turns, i, resolvedModel, maxContext));
  }

  const latest = snapshots[snapshots.length - 1];
  const totalTokens = latest
    ? latest.components.reduce((sum, c) => sum + c.token_count, 0)
    : 0;
  const attentionZones = computeAttentionZones(totalTokens);
  const valleyFlags = latest
    ? flagValleyComponents(latest, attentionZones, valleyThreshold)
    : [];

  const wasteItems = detectWaste(turns, resolvedModel, table);
  const fillRatioByTurn = snapshots.map((s) =>
    contextFillRatio(snapshotTokenTotal(s), s.max_context_tokens),
  );
  const fillRatio = fillRatioByTurn[fillRatioByTurn.length - 1] ?? 0;
  const pressureLevel = contextPressureLevel(fillRatio);
  const suggestions = buildSuggestions(wasteItems, valleyFlags, fillRatio);
  const growthRate = computeGrowthRate(snapshots);

  const harness =
    options.harness ??
    turns.find((t) => t.events.length > 0)?.events[0]?.source.harness ??
    null;
  const { toolResultImpacts, turnDeltas } = buildToolResultImpacts(turns);
  const topOffenderLimit = options.topOffenderLimit ?? 10;
  const topOffenders = [...toolResultImpacts]
    .filter((i) => i.log_status === 'logged' && i.estimated_tokens > 0)
    .sort((a, b) => b.estimated_tokens - a.estimated_tokens)
    .slice(0, topOffenderLimit);
  const categoryTotals = latest
    ? (Object.fromEntries(sumByKind(latest.components)) as Partial<
        Record<ContextComponentKind, number>
      >)
    : {};
  const missingLogs = detectMissingLogs(turns, harness, toolResultImpacts);

  return {
    snapshots,
    maxContextTokens: maxContext,
    fillRatio,
    pressureLevel,
    fillRatioByTurn,
    attentionZones,
    valleyFlags,
    wasteItems,
    suggestions,
    growthRate,
    toolResultImpacts,
    topOffenders,
    turnDeltas,
    categoryTotals,
    missingLogs,
    methodology: METHODOLOGY_NOTE,
  };
}

function buildSnapshot(
  turns: Turn[],
  turnIndex: number,
  model: string,
  maxContext: number,
): ContextSnapshot {
  const turn = turns[turnIndex]!;
  const components: ContextComponent[] = [];
  let position = 0;

  for (let ti = 0; ti <= turnIndex; ti++) {
    for (const event of turns[ti]!.events) {
      const kind = classifyEvent(event, ti, turnIndex);
      if (!kind) continue;

      const { tokenCount, charCount } = estimateTokens(event);
      if (tokenCount <= 0) continue;

      components.push({
        kind,
        source_event_id: event.event_id,
        token_count: tokenCount,
        char_count: charCount,
        cached: event.tokens.cache_read != null && event.tokens.cache_read > 0,
        position_start: position,
        position_end: position + tokenCount,
      });
      position += tokenCount;
    }
  }

  return {
    turn_id: turn.turn_id,
    model,
    max_context_tokens: maxContext,
    components,
  };
}

function classifyEvent(
  event: CanonicalEvent,
  turnIndex: number,
  snapshotTurnIndex: number,
): ContextComponentKind | null {
  if (event.role === 'system') return 'system';

  const metaKind = event.metadata?.kind;
  if (event.event_type === 'meta') {
    if (metaKind === 'system' || metaKind === 'system_prompt') return 'system';
    if (metaKind === 'tool_descriptions' || metaKind === 'tools') return 'tool_descriptions';
    return null;
  }

  if (event.event_type === 'thinking') return 'thinking';

  if (event.event_type === 'tool_result') return 'prior_tool_output';

  if (event.event_type === 'message') {
    if (event.role === 'user') {
      return turnIndex === snapshotTurnIndex ? 'current_user' : 'prior_user';
    }
    if (event.role === 'assistant') return 'prior_assistant';
  }

  if (event.event_type === 'summary' || event.event_type === 'compaction') {
    return 'prior_assistant';
  }

  return null;
}

function contentCharCount(event: CanonicalEvent): number {
  if (typeof event.content === 'string') return event.content.length;
  if (event.content != null && typeof event.content === 'object') {
    return JSON.stringify(event.content).length;
  }
  if (event.event_type === 'tool_result' && event.tool.output != null) {
    return typeof event.tool.output === 'string'
      ? event.tool.output.length
      : JSON.stringify(event.tool.output).length;
  }
  return 0;
}

function estimateTokens(event: CanonicalEvent): { tokenCount: number; charCount: number } {
  const charCount = contentCharCount(event);
  const t = event.tokens;

  if (event.event_type === 'tool_result') {
    if (charCount > 0) {
      return { tokenCount: Math.ceil(charCount / CHARS_PER_TOKEN), charCount };
    }
  }

  const billed =
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.cache_read ?? 0) +
    (t.cache_creation ?? 0) +
    (t.reasoning ?? 0);
  if (billed > 0) {
    return { tokenCount: billed, charCount: charCount || billed * CHARS_PER_TOKEN };
  }

  if (charCount > 0) {
    return { tokenCount: Math.ceil(charCount / CHARS_PER_TOKEN), charCount };
  }

  return { tokenCount: 0, charCount: 0 };
}

function computeAttentionZones(totalTokens: number): AttentionZones {
  const primacyEnd = Math.floor(totalTokens * 0.2);
  const recencyStart = Math.floor(totalTokens * 0.8);
  return {
    primacy_start: 0,
    primacy_end: primacyEnd,
    valley_start: primacyEnd,
    valley_end: recencyStart,
    recency_start: recencyStart,
    recency_end: totalTokens,
    methodology: METHODOLOGY_NOTE,
  };
}

function componentInValley(
  component: ContextComponent,
  zones: AttentionZones,
): boolean {
  const mid = (component.position_start + component.position_end) / 2;
  return mid >= zones.valley_start && mid < zones.valley_end;
}

function flagValleyComponents(
  snapshot: ContextSnapshot,
  zones: AttentionZones,
  threshold: number,
): ValleyFlag[] {
  const flags: ValleyFlag[] = [];
  for (const component of snapshot.components) {
    if (!componentInValley(component, zones)) continue;

    const isUser =
      component.kind === 'prior_user' || component.kind === 'current_user';
    const isLarge = component.token_count >= threshold;

    if (isUser) {
      flags.push({
        turn_id: snapshot.turn_id,
        component,
        reason: 'User message sits in the under-attended middle zone',
      });
    } else if (isLarge) {
      flags.push({
        turn_id: snapshot.turn_id,
        component,
        reason: `Large ${formatKind(component.kind)} block (${component.token_count.toLocaleString()} tokens) in the middle zone`,
      });
    }
  }
  return flags;
}

function toolInputFingerprint(toolName: string | null, input: Record<string, unknown> | null): string | null {
  if (!toolName || !input) return null;

  if (toolName === 'Read' && typeof input.file_path === 'string') {
    return `Read:${input.file_path}`;
  }
  if (toolName === 'Grep') {
    const pattern = input.pattern ?? input.query ?? '';
    const path = input.path ?? input.glob ?? '';
    return `Grep:${String(pattern)}:${String(path)}`;
  }
  if (toolName === 'Glob' && typeof input.glob_pattern === 'string') {
    return `Glob:${input.glob_pattern}`;
  }

  const keys = Object.keys(input).sort();
  const normalized = keys.map((k) => `${k}=${JSON.stringify(input[k])}`).join('|');
  return `${toolName}:${normalized}`;
}

function filePathFromInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  const fp = input.file_path ?? input.path;
  return typeof fp === 'string' ? fp : null;
}

function indexToolResults(events: CanonicalEvent[]): Map<string, CanonicalEvent> {
  const m = new Map<string, CanonicalEvent>();
  for (const e of events) {
    if (e.event_type === 'tool_result' && e.parent_event_id) {
      m.set(e.parent_event_id, e);
    }
  }
  return m;
}

function detectWaste(turns: Turn[], model: string, table: PricingTable): WasteItem[] {
  const waste: WasteItem[] = [];
  const seenFingerprints = new Map<string, { callId: string; resultId: string | null; tokens: number }>();
  const readOutputsByPath = new Map<
    string,
    { callId: string; resultId: string | null; tokens: number }[]
  >();

  for (const turn of turns) {
    const resultsByCall = indexToolResults(turn.events);

    for (const event of turn.events) {
      if (event.event_type !== 'tool_call') continue;

      const toolName = event.tool.name;
      const fp = toolInputFingerprint(toolName, event.tool.input);
      const result = resultsByCall.get(event.event_id);
      const resultTokens = result ? estimateTokens(result).tokenCount : 0;

      if (fp) {
        const prior = seenFingerprints.get(fp);
        if (prior) {
          waste.push({
            kind: 'duplicate_tool_call',
            description: `Duplicate ${toolName} call (${fp.split(':').slice(1).join(':') || 'same input'})`,
            source_event_id: prior.callId,
            related_event_id: event.event_id,
            estimated_tokens: resultTokens,
            estimated_cost_usd: estimateInputCost(model, resultTokens, table),
          });
        } else {
          seenFingerprints.set(fp, {
            callId: event.event_id,
            resultId: result?.event_id ?? null,
            tokens: resultTokens,
          });
        }
      }

      if (toolName === 'Read') {
        const path = filePathFromInput(event.tool.input);
        if (path) {
          const list = readOutputsByPath.get(path) ?? [];
          list.push({
            callId: event.event_id,
            resultId: result?.event_id ?? null,
            tokens: resultTokens,
          });
          readOutputsByPath.set(path, list);
        }
      }

      if (toolName === 'Edit' || toolName === 'Write') {
        const path = filePathFromInput(event.tool.input);
        if (!path) continue;
        const reads = readOutputsByPath.get(path);
        if (!reads) continue;
        for (const read of reads) {
          if (read.tokens <= 0) continue;
          waste.push({
            kind: 'stale_read',
            description: `Read of ${path} superseded by later ${toolName}`,
            source_event_id: read.callId,
            related_event_id: event.event_id,
            estimated_tokens: read.tokens,
            estimated_cost_usd: estimateInputCost(model, read.tokens, table),
          });
        }
        readOutputsByPath.delete(path);
      }
    }
  }

  return waste;
}

function estimateInputCost(
  model: string,
  tokens: number,
  table: PricingTable,
): number | null {
  if (tokens <= 0) return null;
  const r = computeCost({
    model,
    tokens: { input: tokens },
    table,
  });
  return r.method ? r.usd : null;
}

function buildSuggestions(
  wasteItems: WasteItem[],
  valleyFlags: ValleyFlag[],
  fillRatio: number,
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = [];

  if (fillRatio >= CONTEXT_PRESSURE_THRESHOLD) {
    const pct = Math.round(fillRatio * 100);
    suggestions.push({
      kind: 'compress',
      reason: `Reconstructed context is ~${pct}% of the model window — many agents compact or summarize beyond ~80%`,
    });
  }

  const dupes = wasteItems.filter((w) => w.kind === 'duplicate_tool_call');
  if (dupes.length > 0) {
    suggestions.push({
      kind: 'trim',
      reason: `${dupes.length} duplicate tool call${dupes.length > 1 ? 's' : ''} could be removed from context to save tokens`,
    });
  }

  const stale = wasteItems.filter((w) => w.kind === 'stale_read');
  if (stale.length > 0) {
    suggestions.push({
      kind: 'trim',
      reason: `${stale.length} file read output${stale.length > 1 ? 's are' : ' is'} stale after later edits — consider dropping earlier reads`,
    });
  }

  const userInValley = valleyFlags.filter(
    (f) => f.component.kind === 'prior_user' || f.component.kind === 'current_user',
  );
  if (userInValley.length > 0) {
    suggestions.push({
      kind: 'reorder',
      reason: 'Key user requirements sit in the under-attended middle zone — move critical instructions closer to the latest message',
    });
  }

  const largeValley = valleyFlags.filter(
    (f) =>
      f.component.kind !== 'prior_user' &&
      f.component.kind !== 'current_user',
  );
  if (largeValley.length > 0) {
    suggestions.push({
      kind: 'compress',
      reason: `${largeValley.length} large context block${largeValley.length > 1 ? 's' : ''} in the middle zone could be summarized`,
    });
  }

  const toolOutputHeavy = valleyFlags.some((f) => f.component.kind === 'prior_tool_output');
  if (toolOutputHeavy && dupes.length === 0) {
    suggestions.push({
      kind: 'cache',
      reason: 'Stable prefix content followed by changing tool outputs may reduce cache hit rate — keep static instructions at the front',
    });
  }

  return suggestions;
}

function sumByKind(components: ContextComponent[]): Map<ContextComponentKind, number> {
  const m = new Map<ContextComponentKind, number>();
  for (const c of components) {
    m.set(c.kind, (m.get(c.kind) ?? 0) + c.token_count);
  }
  return m;
}

function computeGrowthRate(snapshots: ContextSnapshot[]): ContextComponentKind | null {
  if (snapshots.length < 2) return null;

  let maxKind: ContextComponentKind | null = null;
  let maxDelta = 0;

  for (let i = 1; i < snapshots.length; i++) {
    const prev = sumByKind(snapshots[i - 1]!.components);
    const curr = sumByKind(snapshots[i]!.components);
    const kinds = new Set([...prev.keys(), ...curr.keys()]);

    for (const kind of kinds) {
      const delta = (curr.get(kind) ?? 0) - (prev.get(kind) ?? 0);
      if (delta > maxDelta) {
        maxDelta = delta;
        maxKind = kind;
      }
    }
  }

  return maxKind;
}

function formatKind(kind: ContextComponentKind): string {
  return kind.replace(/_/g, ' ');
}

/** Human-readable label for a tool_call (file path, command, etc.). */
export function describeToolCall(event: CanonicalEvent): string {
  const name = event.tool.name ?? 'tool';
  const input = event.tool.input;
  if (!input) return name;

  if (name === 'Read' && typeof input.file_path === 'string') {
    return `Read ${input.file_path}`;
  }
  if (name === 'Write' && typeof input.file_path === 'string') {
    return `Write ${input.file_path}`;
  }
  if (name === 'Edit' && typeof input.file_path === 'string') {
    return `Edit ${input.file_path}`;
  }
  if (name === 'Bash' || name === 'exec_command') {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === 'string') return `${name} ${cmd.slice(0, 80)}`;
  }
  if (name === 'Grep') {
    const pattern = input.pattern ?? input.query ?? '';
    const path = input.path ?? input.glob ?? '';
    return `Grep "${String(pattern)}"${path ? ` in ${String(path)}` : ''}`;
  }
  if (name === 'Glob' && typeof input.glob_pattern === 'string') {
    return `Glob ${input.glob_pattern}`;
  }

  return name;
}

function indexSessionToolCalls(
  turns: Turn[],
): Map<string, { call: CanonicalEvent; turnIndex: number; turnId: string }> {
  const m = new Map<string, { call: CanonicalEvent; turnIndex: number; turnId: string }>();
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti]!;
    for (const event of turn.events) {
      if (event.event_type === 'tool_call') {
        m.set(event.event_id, { call: event, turnIndex: ti, turnId: turn.turn_id });
      }
    }
  }
  return m;
}

function indexSessionToolResults(
  turns: Turn[],
): Map<string, { result: CanonicalEvent; turnIndex: number; turnId: string }> {
  const m = new Map<string, { result: CanonicalEvent; turnIndex: number; turnId: string }>();
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti]!;
    for (const event of turn.events) {
      if (event.event_type === 'tool_result' && event.parent_event_id) {
        m.set(event.parent_event_id, { result: event, turnIndex: ti, turnId: turn.turn_id });
      }
    }
  }
  return m;
}

function buildToolResultImpacts(turns: Turn[]): {
  toolResultImpacts: ToolResultContextImpact[];
  turnDeltas: TurnContextDelta[];
} {
  const toolResultImpacts: ToolResultContextImpact[] = [];
  const turnDeltas: TurnContextDelta[] = [];
  const sessionResults = indexSessionToolResults(turns);
  const sessionCalls = indexSessionToolCalls(turns);
  const missingCallsReported = new Set<string>();
  let cumulative = 0;

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti]!;
    const turnStart = cumulative;

    for (const event of turn.events) {
      if (event.event_type === 'tool_call') {
        if (sessionResults.has(event.event_id) || missingCallsReported.has(event.event_id)) {
          continue;
        }
        missingCallsReported.add(event.event_id);
        toolResultImpacts.push({
          call_event_id: event.event_id,
          result_event_id: null,
          tool_name: event.tool.name,
          label: describeToolCall(event),
          turn_id: turn.turn_id,
          turn_index: ti,
          estimated_tokens: 0,
          cumulative_after: cumulative,
          log_status: 'missing',
        });
        continue;
      }

      if (event.event_type !== 'tool_result') continue;

      const tokens = estimateTokens(event).tokenCount;
      cumulative += tokens;

      const parentId = event.parent_event_id;
      const callInfo = parentId ? sessionCalls.get(parentId) : undefined;
      const isOrphan = event.metadata?.orphan === true || !parentId || !callInfo;
      const logStatus: ToolResultLogStatus = isOrphan
        ? 'orphan'
        : tokens <= 0
          ? 'empty'
          : 'logged';

      toolResultImpacts.push({
        call_event_id: parentId,
        result_event_id: event.event_id,
        tool_name: callInfo?.call.tool.name ?? event.tool.name,
        label: callInfo ? describeToolCall(callInfo.call) : 'Orphan tool result',
        turn_id: turn.turn_id,
        turn_index: ti,
        estimated_tokens: tokens,
        cumulative_after: cumulative,
        log_status: logStatus,
      });
    }

    turnDeltas.push({
      turn_id: turn.turn_id,
      turn_index: ti,
      delta_tokens: cumulative - turnStart,
      cumulative_tokens: cumulative,
    });
  }

  return { toolResultImpacts, turnDeltas };
}

function detectMissingLogs(
  turns: Turn[],
  harness: Harness | null,
  impacts: ToolResultContextImpact[],
): MissingLogItem[] {
  const items: MissingLogItem[] = [];

  for (const impact of impacts) {
    if (impact.log_status === 'missing') {
      items.push({
        kind: 'missing_tool_result',
        description: `No tool result in log for ${impact.label}`,
        call_event_id: impact.call_event_id,
        result_event_id: null,
        turn_id: impact.turn_id,
        turn_index: impact.turn_index,
        tool_name: impact.tool_name,
        jump_event_id: impact.call_event_id,
      });
      continue;
    }

    if (impact.log_status === 'orphan') {
      items.push({
        kind: 'orphan_tool_result',
        description: 'Tool result in log but its tool call is missing (often after compaction)',
        call_event_id: impact.call_event_id,
        result_event_id: impact.result_event_id,
        turn_id: impact.turn_id,
        turn_index: impact.turn_index,
        tool_name: impact.tool_name,
        jump_event_id: impact.result_event_id,
      });
      continue;
    }

    if (impact.log_status === 'empty') {
      items.push({
        kind: 'empty_tool_output',
        description: `Tool result logged for ${impact.label} but output is empty — context impact unknown`,
        call_event_id: impact.call_event_id,
        result_event_id: impact.result_event_id,
        turn_id: impact.turn_id,
        turn_index: impact.turn_index,
        tool_name: impact.tool_name,
        jump_event_id: impact.result_event_id ?? impact.call_event_id,
      });
    }
  }

  if (harness === 'cursor') {
    let callCount = 0;
    let resultCount = 0;
    for (const turn of turns) {
      for (const event of turn.events) {
        if (event.event_type === 'tool_call') callCount++;
        if (event.event_type === 'tool_result') resultCount++;
      }
    }
    if (callCount > 0 && resultCount === 0) {
      const firstTurn = turns[0];
      items.unshift({
        kind: 'harness_no_tool_results',
        description:
          'Cursor JSONL transcripts do not export tool outputs — per-tool context sizing is unavailable for this session',
        call_event_id: null,
        result_event_id: null,
        turn_id: firstTurn?.turn_id ?? '',
        turn_index: 0,
        tool_name: null,
        jump_event_id: null,
      });
    }
  }

  return items;
}

/** @internal exported for tests */
export function __testables() {
  return {
    classifyEvent,
    estimateTokens,
    toolInputFingerprint,
    computeAttentionZones,
    componentInValley,
    buildSnapshot,
    buildToolResultImpacts,
    detectMissingLogs,
    describeToolCall,
  };
}
