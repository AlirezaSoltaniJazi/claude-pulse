import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearAllScanCaches, scanWeeklyUsage } from '../src/data/jsonlScanner';
import { forEachLine } from '../src/utils/jsonlLines';

// Wrapped, not replaced: the scanner really reads, and the tests can see from where.
vi.mock('../src/utils/jsonlLines', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/jsonlLines')>();
  return { forEachLine: vi.fn(actual.forEachLine) };
});
const reads = vi.mocked(forEachLine);

let claudeHome: string;
let projectDir: string;

/** An assistant turn timestamped now, so it always falls inside the current week. */
const assistant = (tokens: number): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: tokens,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: 'tool_use' }],
    },
  }) + '\n';

const transcript = (name: string): string => path.join(projectDir, `${name}.jsonl`);

describe('scanWeeklyUsage', () => {
  beforeEach(() => {
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-scan-'));
    projectDir = path.join(claudeHome, 'projects', '-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    clearAllScanCaches();
  });

  afterEach(() => {
    reads.mockClear();
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('totals the week across transcripts', async () => {
    fs.writeFileSync(transcript('a'), assistant(100) + assistant(50));
    fs.writeFileSync(transcript('b'), assistant(7));

    const week = await scanWeeklyUsage(claudeHome, true);
    expect(week).toMatchObject({ totalTokens: 157, totalMessages: 3, totalSessions: 2 });
    expect(week?.totalToolCalls).toBe(3);
  });

  it('reads only the appended bytes of a grown transcript', async () => {
    fs.writeFileSync(transcript('a'), assistant(100));
    await scanWeeklyUsage(claudeHome, true);

    reads.mockClear();
    const sizeBefore = fs.statSync(transcript('a')).size;
    fs.appendFileSync(transcript('a'), assistant(20));

    const week = await scanWeeklyUsage(claudeHome, true);
    expect(week?.totalTokens).toBe(120);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0][1]).toBe(sizeBefore);
  });

  it('does not read an unchanged transcript again', async () => {
    fs.writeFileSync(transcript('a'), assistant(100));
    await scanWeeklyUsage(claudeHome, true);

    reads.mockClear();
    const week = await scanWeeklyUsage(claudeHome, true);
    expect(week?.totalTokens).toBe(100);
    expect(reads).not.toHaveBeenCalled();
  });

  it('starts over when a transcript is rewritten shorter', async () => {
    fs.writeFileSync(transcript('a'), assistant(100) + assistant(100));
    await scanWeeklyUsage(claudeHome, true);

    fs.writeFileSync(transcript('a'), assistant(5));
    const week = await scanWeeklyUsage(claudeHome, true);
    expect(week?.totalTokens).toBe(5);
  });

  it('drops a deleted transcript from the totals', async () => {
    fs.writeFileSync(transcript('a'), assistant(100));
    fs.writeFileSync(transcript('b'), assistant(1));
    await scanWeeklyUsage(claudeHome, true);

    fs.rmSync(transcript('a'));
    const week = await scanWeeklyUsage(claudeHome, true);
    expect(week?.totalTokens).toBe(1);
  });

  it('shares one scan between callers that arrive while it runs', async () => {
    fs.writeFileSync(transcript('a'), assistant(100));

    const results = await Promise.all([
      scanWeeklyUsage(claudeHome, true),
      scanWeeklyUsage(claudeHome, true),
      scanWeeklyUsage(claudeHome, true),
    ]);

    expect(results.map((r) => r?.totalTokens)).toEqual([100, 100, 100]);
    // Three callers, one read of the one transcript.
    expect(reads).toHaveBeenCalledTimes(1);
  });
});
