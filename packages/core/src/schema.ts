// Canonical event schema. Mirrors PRD §8.
// The shape stored in SQLite. Adapters produce these from harness-specific
// formats; the UI and analytics layers consume them.

export const CANONICAL_SCHEMA_VERSION = '0.1.0';

export type Harness = 'claude_code' | 'opencode' | 'codex' | 'cursor';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type EventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'meta'
  | 'summary'
  | 'compaction';

export type CostMethod = 'logged' | 'estimated' | null;
export type ToolStatus = 'success' | 'error' | null;

export interface EventSource {
  harness: Harness;
  format_version: string;
  raw_path: string;
}

export interface EventTokens {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_creation: number | null;
  reasoning: number | null;
}

export interface EventTool {
  name: string | null;
  input: Record<string, unknown> | null;
  output: string | Record<string, unknown> | null;
  status: ToolStatus;
  error_message: string | null;
}

export interface CanonicalEvent {
  event_id: string;
  session_id: string;
  turn_id: string;
  parent_event_id: string | null;
  timestamp: string; // ISO 8601
  source: EventSource;
  role: Role;
  event_type: EventType;
  model: string | null;
  tokens: EventTokens;
  cost_usd: number | null;
  cost_method: CostMethod;
  duration_ms: number | null;
  content: string | Record<string, unknown> | null;
  tool: EventTool;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
}

// Per-turn context snapshot (PRD §8). Populated only when the adapter has the
// full request payload; v0.1 leaves this empty for Claude Code.

export type ContextComponentKind =
  | 'system'
  | 'tool_descriptions'
  | 'prior_assistant'
  | 'prior_tool_output'
  | 'prior_user'
  | 'current_user'
  | 'thinking';

export interface ContextComponent {
  kind: ContextComponentKind;
  source_event_id: string | null;
  token_count: number;
  char_count: number;
  cached: boolean | null;
  position_start: number;
  position_end: number;
}

export interface ContextSnapshot {
  turn_id: string;
  model: string;
  max_context_tokens: number;
  components: ContextComponent[];
}

// Session: the unit a user browses to. One adapter parse pass typically
// produces one Session plus many CanonicalEvents.

export interface Session {
  session_id: string;
  harness: Harness;
  project_path: string;
  title: string | null;
  started_at: string; // ISO 8601
  ended_at: string | null;
  model: string | null;
  raw_path: string; // absolute path to source file/dir
  format_version: string;
  mtime_ms: number; // for incremental re-index
}

// Derived/aggregated fields — not stored, computed at query time.

export interface SessionAggregates {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  duration_ms: number;
  turn_count: number;
  tool_call_count: number;
  tool_error_count: number;
  message_count: number;
  files_touched: string[];
  models_used: string[];
}

export type SessionWithAggregates = Session & { aggregates: SessionAggregates };

// A "turn" is a logical grouping of events that share a turn_id. The UI
// renders one turn block per group.

export interface Turn {
  turn_id: string;
  session_id: string;
  started_at: string;
  ended_at: string;
  events: CanonicalEvent[];
}
