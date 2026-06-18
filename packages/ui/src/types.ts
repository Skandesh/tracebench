// Mirror of the API response shapes. Kept here so the UI doesn't have a
// build-time dependency on @tracebench/core types; the API is the contract.

export type Harness = 'claude_code' | 'opencode' | 'codex' | 'cursor';
export type ViewMode = 'timeline' | 'dashboard' | 'search';
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type EventType =
  | 'message'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'meta'
  | 'summary'
  | 'compaction';

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
  status: 'success' | 'error' | null;
  error_message: string | null;
}

export interface CanonicalEvent {
  event_id: string;
  session_id: string;
  turn_id: string;
  parent_event_id: string | null;
  timestamp: string;
  source: { harness: Harness; format_version: string; raw_path: string; line?: number; raw_index?: number };
  role: Role;
  event_type: EventType;
  model: string | null;
  tokens: EventTokens;
  cost_usd: number | null;
  cost_method: 'logged' | 'estimated' | null;
  duration_ms: number | null;
  content: string | Record<string, unknown> | null;
  tool: EventTool;
  metadata: Record<string, unknown>;
  raw: Record<string, unknown>;
}

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

export interface Session {
  session_id: string;
  harness: Harness;
  project_path: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  raw_path: string;
  format_version: string;
  mtime_ms: number;
  aggregates: SessionAggregates;
  index_state?: DiscoveredSessionIndexState;
  source_size?: number;
  indexed_at?: string | null;
  error_message?: string | null;
  indexed?: boolean;
}

export type DiscoveredSessionIndexState =
  | 'discovered'
  | 'indexing'
  | 'hot'
  | 'warm'
  | 'raw_archived'
  | 'error';

export interface DiscoveredSession {
  harness: Harness;
  session_id: string;
  raw_path: string;
  format_version: string;
  source_size: number;
  mtime_ms: number;
  index_state: DiscoveredSessionIndexState;
  indexed_at: string | null;
  error_message: string | null;
}

export interface StorageReport {
  db: {
    total_bytes: number;
    wal_bytes: number;
  };
  discovery: {
    total_sessions: number;
    indexed_sessions: number;
    manifest_sessions: number;
    per_harness: Record<
      string,
      {
        discovered: number;
        indexed: number;
        manifest: number;
        states: Record<string, number>;
      }
    >;
  };
  payload_bytes: {
    total_json: number;
    external_payload_count: number;
    external_payload_compressed_bytes: number;
  };
  index_runs?: {
    total: number;
    indexing: number;
    published: number;
    error: number;
  };
}

export interface ToolCount {
  tool_name: string;
  count: number;
  errors: number;
}

// Cross-session search (mirrors the /api/search response shape).
export interface SearchMatch {
  chunk_id: number;
  event_id: string;
  turn_id: string | null;
  snippet: string;
  source: 'lexical' | 'semantic';
}

export interface SearchResultGroup {
  session: Session;
  score: number;
  matches: SearchMatch[];
}

export interface SearchEventsResult {
  results: SearchResultGroup[];
  total: number;
  semanticAvailable: boolean;
}

export interface Turn {
  turn_id: string;
  session_id: string;
  started_at: string;
  ended_at: string;
  events: CanonicalEvent[];
}
