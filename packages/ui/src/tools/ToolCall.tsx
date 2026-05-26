// Renders a tool_call canonical event plus its matched tool_result.
// Falls back to a generic JSON view for unknown tools.

import { useEffect, type ReactNode } from 'react';
import { useDisclosure } from '../hooks/useDisclosure';
import type { ToolResultContextImpact } from '@tracebench/core/context-analyzer';
import type { CanonicalEvent } from '../types';
import { Icons, type IconName } from '../icons';
import { formatMs, formatTokensCompact } from '../format';

interface ToolCallProps {
  call: CanonicalEvent;
  result?: CanonicalEvent | undefined;
  defaultOpen?: boolean;
  highlighted?: boolean;
  onClearHighlight?: () => void;
  contextImpact?: ToolResultContextImpact;
}

const HIGHLIGHT_DURATION_MS = 1200;

/**
 * Auto-clear the highlight after the pulse animation completes. The effect
 * depends on `onClearHighlight` — callers should pass a stable reference
 * (e.g. wrapped in `useCallback`) so the timer isn't reset on every render.
 */
function useHighlightAutoClear(highlighted: boolean | undefined, onClearHighlight: (() => void) | undefined): void {
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => onClearHighlight?.(), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [highlighted, onClearHighlight]);
}

/**
 * Wrapper around every tool renderer. Owns the outer wrapper div and all
 * cross-cutting concerns: highlight class, scroll target (data-event-id),
 * status attribute, auto-clear timer. Renderers only provide their content.
 */
function ToolShell({
  kind,
  call,
  status,
  highlighted,
  onClearHighlight,
  children,
}: {
  kind: 'bash' | 'read' | 'edit' | 'write' | 'grep' | 'generic';
  call: CanonicalEvent;
  status?: 'ok' | 'err';
  highlighted?: boolean;
  onClearHighlight?: () => void;
  children: ReactNode;
}) {
  useHighlightAutoClear(highlighted, onClearHighlight);
  return (
    <div
      className={`tb-tool tb-tool-${kind}${highlighted ? ' tb-tool-highlighted' : ''}`}
      data-event-id={call.event_id}
      {...(status ? { 'data-status': status } : {})}
    >
      {children}
    </div>
  );
}

export function ToolCallView({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const name = call.tool.name ?? 'tool';
  const props = { call, result, highlighted, onClearHighlight, contextImpact };
  // Codex aliases — its tool names differ but the renderer can be reused.
  switch (name) {
    case 'Bash':
    case 'exec_command':
      return <BashTool {...props} defaultOpen={defaultOpen ?? true} />;
    case 'Read':
    case 'view':
      return <ReadTool {...props} defaultOpen={defaultOpen ?? false} />;
    case 'Edit':
    case 'apply_patch':
      return <EditTool {...props} defaultOpen={defaultOpen ?? true} />;
    case 'Write':
      return <WriteTool {...props} defaultOpen={defaultOpen ?? false} />;
    case 'Grep':
      return <GrepTool {...props} defaultOpen={defaultOpen ?? false} />;
    default:
      return <GenericTool {...props} defaultOpen={defaultOpen ?? false} />;
  }
}

interface HeadProps {
  tool: string;
  iconName?: IconName;
  summary: ReactNode;
  ms?: number | null;
  kids?: ReactNode;
  status?: 'ok' | 'err';
  open: boolean;
  onToggle: () => void;
  tokenEstimate?: number | null;
  logNote?: ReactNode;
}

function ToolHead({ tool, iconName, summary, ms, kids, status = 'ok', open, onToggle, tokenEstimate, logNote }: HeadProps) {
  const Icon = iconName && Icons[iconName] ? Icons[iconName] : Icons.Hash;
  return (
    <button className="tb-tool-head" onClick={onToggle} data-open={open ? '1' : '0'}>
      <span className="tb-tool-chev"><Icons.Chevron size={11} dir={open ? 'down' : 'right'} /></span>
      <span className={`tb-tool-ico tb-tool-${tool.toLowerCase()}`}><Icon size={12} /></span>
      <span className="tb-tool-name">{tool}</span>
      <span className="tb-tool-summary">{summary}</span>
      <span className="tb-tool-meta">
        {logNote}
        {tokenEstimate != null && tokenEstimate > 0 && (
          <span className="tb-tool-tok">~{formatTokensCompact(tokenEstimate)} tok</span>
        )}
        {kids && <span className="tb-tool-kids">{kids}</span>}
        {ms != null && <span className="tb-tool-ms">{formatMs(ms)}</span>}
        {status === 'err' && <span className="tb-tool-status tb-tool-status-err">error</span>}
      </span>
    </button>
  );
}

function toolContextMeta(contextImpact?: ToolResultContextImpact, result?: CanonicalEvent) {
  if (contextImpact?.log_status === 'missing') {
    return {
      tokenEstimate: null as number | null,
      logNote: <span className="tb-tool-log-missing">No result in log</span>,
    };
  }
  if (contextImpact?.log_status === 'empty') {
    return {
      tokenEstimate: null as number | null,
      logNote: <span className="tb-tool-log-missing">Empty output in log</span>,
    };
  }
  const tokens = contextImpact?.estimated_tokens ?? 0;
  const showSize = tokens >= 8_000;
  return {
    tokenEstimate: showSize ? tokens : null,
    logNote: undefined as ReactNode,
  };
}

function toolStatus(result?: CanonicalEvent): 'ok' | 'err' {
  if (!result) return 'ok';
  return result.tool.status === 'error' ? 'err' : 'ok';
}

function outputAsString(result?: CanonicalEvent): string {
  if (!result) return '';
  const out = result.tool.output;
  if (typeof out === 'string') return out;
  if (out == null) return '';
  return JSON.stringify(out, null, 2);
}

function colorLine(line: string): string {
  if (/^\s*[×✗]/.test(line) || /\bFAIL\b/i.test(line) || /\bfail/i.test(line)) return 'tb-line tb-line-err';
  if (/^\s*[✓]/.test(line) || /\bPASS\b/i.test(line) || /\bpass/i.test(line)) return 'tb-line tb-line-ok';
  if (/^\s*RUN\b/.test(line)) return 'tb-line tb-line-info';
  return 'tb-line';
}

// ── Bash ──────────────────────────────────────────────────────────────────

function BashTool({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const { open, toggle } = useDisclosure(defaultOpen);
  // Claude Code uses `command`; Codex `exec_command` uses `cmd`.
  const input = (call.tool.input ?? {}) as { command?: string; cmd?: string; description?: string };
  const command = input.command ?? input.cmd ?? '';
  const output = outputAsString(result);
  const status = toolStatus(result);
  const lines = output.split('\n');
  const ctx = toolContextMeta(contextImpact, result);

  return (
    <ToolShell
      kind="bash"
      call={call}
      highlighted={highlighted}
      onClearHighlight={onClearHighlight}
      status={status}
    >
      <ToolHead
        tool="Bash"
        iconName="Bash"
        open={open}
        onToggle={toggle}
        summary={<span className="tb-tool-summary-text">{command}</span>}
        ms={result?.duration_ms ?? null}
        status={status}
        tokenEstimate={ctx.tokenEstimate}
        logNote={ctx.logNote}
      />
      {open && (
        <div className="tb-tool-body tb-bash-body">
          <div className="tb-bash-cmd"><span className="tb-prompt">$</span><span>{command}</span></div>
          {output && (
            <div className="tb-bash-out">
              {lines.slice(0, 200).map((l, i) => (
                <div key={i} className={colorLine(l)}>{l || ' '}</div>
              ))}
              {lines.length > 200 && (
                <div className="tb-line tb-mute">⋯ {lines.length - 200} more lines (truncated)</div>
              )}
            </div>
          )}
        </div>
      )}
    </ToolShell>
  );
}

// ── Read ──────────────────────────────────────────────────────────────────

function ReadTool({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const { open, toggle } = useDisclosure(defaultOpen);
  const input = (call.tool.input ?? {}) as { file_path?: string; offset?: number; limit?: number };
  const file = input.file_path ?? '';
  const range =
    input.offset != null
      ? `L${input.offset}–${input.offset + (input.limit ?? 0)}`
      : input.limit != null
        ? `L1–${input.limit}`
        : '';
  const output = outputAsString(result);
  const lineCount = output ? output.split('\n').length : 0;
  const ctx = toolContextMeta(contextImpact, result);

  return (
    <ToolShell
      kind="read"
      call={call}
      highlighted={highlighted}
      onClearHighlight={onClearHighlight}
    >
      <ToolHead
        tool="Read"
        iconName="Read"
        open={open}
        onToggle={toggle}
        summary={<><span className="tb-path">{file}</span>{range && <span className="tb-range">{range}</span>}</>}
        kids={lineCount ? `${lineCount} lines` : undefined}
        status={toolStatus(result)}
        tokenEstimate={ctx.tokenEstimate}
        logNote={ctx.logNote}
      />
      {open && output && (
        <div className="tb-tool-body tb-read-body">
          <pre className="tb-pre">{output.slice(0, 8000)}{output.length > 8000 ? '\n…' : ''}</pre>
        </div>
      )}
    </ToolShell>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────────

function EditTool({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const { open, toggle } = useDisclosure(defaultOpen);
  // Claude Code Edit input: { file_path, old_string, new_string }.
  // Codex apply_patch input: { _raw: patch-string }.
  const input = (call.tool.input ?? {}) as {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    _raw?: string;
  };
  const isPatch = typeof input._raw === 'string' && input._raw.length > 0;
  const patchLines = isPatch ? input._raw!.split('\n') : [];
  const patchFile = isPatch
    ? (patchLines.find((l) => /\*\*\* (Update|Add|Delete) File:/.test(l))?.replace(/.*File:\s*/, '') ?? '')
    : input.file_path ?? '';
  const adds = isPatch
    ? patchLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    : (input.new_string ?? '').split('\n').length;
  const dels = isPatch
    ? patchLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    : (input.old_string ?? '').split('\n').length;
  const oldLines = (input.old_string ?? '').split('\n');
  const newLines = (input.new_string ?? '').split('\n');
  const ctx = toolContextMeta(contextImpact, result);

  return (
    <ToolShell
      kind="edit"
      call={call}
      highlighted={highlighted}
      onClearHighlight={onClearHighlight}
    >
      <ToolHead
        tool={isPatch ? 'apply_patch' : 'Edit'}
        iconName="Edit"
        open={open}
        onToggle={toggle}
        summary={<span className="tb-path">{patchFile}</span>}
        kids={<><span className="tb-add">+{adds}</span> <span className="tb-del">-{dels}</span></>}
        status={toolStatus(result)}
        tokenEstimate={ctx.tokenEstimate}
        logNote={ctx.logNote}
      />
      {open && (
        <div className="tb-tool-body tb-edit-body">
          <div className="tb-diff">
            {isPatch ? (
              patchLines.map((l, i) => {
                const cls =
                  l.startsWith('+') && !l.startsWith('+++')
                    ? 'tb-diff-line tb-diff-add'
                    : l.startsWith('-') && !l.startsWith('---')
                      ? 'tb-diff-line tb-diff-del'
                      : 'tb-diff-line';
                const marker = l.startsWith('+') ? '+' : l.startsWith('-') ? '-' : ' ';
                return (
                  <div key={i} className={cls}>
                    <span className="tb-diff-marker">{marker}</span>
                    <span className="tb-diff-content">{l || ' '}</span>
                  </div>
                );
              })
            ) : (
              <>
                {oldLines.map((l, i) => (
                  <div key={`o${i}`} className="tb-diff-line tb-diff-del">
                    <span className="tb-diff-marker">-</span>
                    <span className="tb-diff-content">{l || ' '}</span>
                  </div>
                ))}
                {newLines.map((l, i) => (
                  <div key={`n${i}`} className="tb-diff-line tb-diff-add">
                    <span className="tb-diff-marker">+</span>
                    <span className="tb-diff-content">{l || ' '}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </ToolShell>
  );
}

// ── Write ─────────────────────────────────────────────────────────────────

function WriteTool({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const { open, toggle } = useDisclosure(defaultOpen);
  const input = (call.tool.input ?? {}) as { file_path?: string; content?: string };
  const content = input.content ?? '';
  const lineCount = content ? content.split('\n').length : 0;
  const ctx = toolContextMeta(contextImpact, result);

  return (
    <ToolShell
      kind="write"
      call={call}
      highlighted={highlighted}
      onClearHighlight={onClearHighlight}
    >
      <ToolHead
        tool="Write"
        iconName="Write"
        open={open}
        onToggle={toggle}
        summary={<span className="tb-path">{input.file_path ?? ''}</span>}
        kids={lineCount ? <span className="tb-add">+{lineCount}</span> : undefined}
        status={toolStatus(result)}
        tokenEstimate={ctx.tokenEstimate}
        logNote={ctx.logNote}
      />
      {open && content && (
        <div className="tb-tool-body tb-write-body">
          <pre className="tb-pre">{content.slice(0, 8000)}{content.length > 8000 ? '\n…' : ''}</pre>
        </div>
      )}
    </ToolShell>
  );
}

// ── Grep ──────────────────────────────────────────────────────────────────

function GrepTool({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const { open, toggle } = useDisclosure(defaultOpen);
  const input = (call.tool.input ?? {}) as { pattern?: string; path?: string; glob?: string };
  const output = outputAsString(result);
  const matchCount = output ? output.split('\n').filter((l) => l.trim()).length : 0;
  const ctx = toolContextMeta(contextImpact, result);

  return (
    <ToolShell
      kind="grep"
      call={call}
      highlighted={highlighted}
      onClearHighlight={onClearHighlight}
    >
      <ToolHead
        tool="Grep"
        iconName="Grep"
        open={open}
        onToggle={toggle}
        summary={
          <>
            <span className="tb-quoted">&quot;{input.pattern ?? ''}&quot;</span>
            {input.path && <span className="tb-mute">in</span>}
            {input.path && <span className="tb-path">{input.path}</span>}
          </>
        }
        kids={matchCount ? `${matchCount} matches` : undefined}
        status={toolStatus(result)}
        tokenEstimate={ctx.tokenEstimate}
        logNote={ctx.logNote}
      />
      {open && output && (
        <div className="tb-tool-body tb-read-body">
          <pre className="tb-pre">{output.slice(0, 8000)}{output.length > 8000 ? '\n…' : ''}</pre>
        </div>
      )}
    </ToolShell>
  );
}

// ── Fallback for unknown tools ────────────────────────────────────────────

function GenericTool({ call, result, defaultOpen, highlighted, onClearHighlight, contextImpact }: ToolCallProps) {
  const { open, toggle } = useDisclosure(defaultOpen);
  const name = call.tool.name ?? 'tool';
  const ctx = toolContextMeta(contextImpact, result);

  return (
    <ToolShell
      kind="generic"
      call={call}
      highlighted={highlighted}
      onClearHighlight={onClearHighlight}
    >
      <ToolHead
        tool={name}
        open={open}
        onToggle={toggle}
        summary={<span className="tb-mute">{Object.keys(call.tool.input ?? {}).join(', ') || '—'}</span>}
        status={toolStatus(result)}
        tokenEstimate={ctx.tokenEstimate}
        logNote={ctx.logNote}
      />
      {open && (
        <div className="tb-tool-body">
          <pre className="tb-pre">{JSON.stringify(call.tool.input, null, 2)}</pre>
          {result && (
            <>
              <div className="tb-section-head" style={{ marginTop: '0.5rem' }}>output</div>
              <pre className="tb-pre">{outputAsString(result).slice(0, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </ToolShell>
  );
}
