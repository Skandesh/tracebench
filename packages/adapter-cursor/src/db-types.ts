export interface ComposerHeaderEntry {
  type?: string;
  composerId: string;
  name?: string;
  subtitle?: string;
  lastUpdatedAt?: number;
  createdAt?: number;
  unifiedMode?: string;
  isArchived?: boolean;
  workspaceIdentifier?: {
    uri?: { fsPath?: string; path?: string };
  };
}

export interface ConversationHeader {
  bubbleId: string;
  type: number; // 1 = user, 2 = assistant
}

export interface ComposerDataRow {
  composerId: string;
  name?: string;
  subtitle?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  unifiedMode?: string;
  status?: string;
  fullConversationHeadersOnly?: ConversationHeader[];
  workspaceIdentifier?: {
    uri?: { fsPath?: string; path?: string };
  };
  modelConfig?: { modelName?: string };
  isArchived?: boolean;
  isDraft?: boolean;
}

export interface CursorBubble {
  bubbleId?: string;
  type?: number;
  text?: string;
  richText?: string;
  createdAt?: string;
  capabilityType?: number;
  thinking?: { text?: string };
  thinkingDurationMs?: number;
  modelInfo?: { modelName?: string };
  tokenCount?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  toolFormerData?: {
    toolCallId?: string;
    name?: string;
    status?: string;
    rawArgs?: string;
    params?: string;
    result?: string;
    additionalData?: Record<string, unknown>;
  };
}
