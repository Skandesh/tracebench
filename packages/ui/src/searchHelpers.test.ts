import { describe, it, expect } from 'vitest';
import { parseSnippet, resumeCommand, SNIPPET_OPEN, SNIPPET_CLOSE } from './searchHelpers';

describe('parseSnippet', () => {
  it('splits sentinel-delimited matches into plain/match segments', () => {
    const s = `before ${SNIPPET_OPEN}match${SNIPPET_CLOSE} after`;
    expect(parseSnippet(s)).toEqual([
      { text: 'before ', match: false },
      { text: 'match', match: true },
      { text: ' after', match: false },
    ]);
  });

  it('returns one plain segment when there are no matches', () => {
    expect(parseSnippet('plain text')).toEqual([{ text: 'plain text', match: false }]);
  });

  it('tolerates an unclosed sentinel', () => {
    expect(parseSnippet(`a ${SNIPPET_OPEN}b`)).toEqual([
      { text: 'a ', match: false },
      { text: 'b', match: true },
    ]);
  });

  it('keeps markup as inert plain text (rendered as text nodes, never HTML)', () => {
    expect(parseSnippet(`${SNIPPET_OPEN}<script>${SNIPPET_CLOSE}`)).toEqual([
      { text: '<script>', match: true },
    ]);
  });
});

describe('resumeCommand', () => {
  it('builds harness-native resume commands; cursor has none', () => {
    expect(resumeCommand('claude_code', 'abc')).toBe('claude --resume abc');
    expect(resumeCommand('codex', 'abc')).toBe('codex resume abc');
    expect(resumeCommand('opencode', 'abc')).toBe('opencode --session abc');
    expect(resumeCommand('cursor', 'abc')).toBeNull();
  });
});
