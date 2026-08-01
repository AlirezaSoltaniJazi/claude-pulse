import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readModelInfo, clearModelCache, encodeProjectDirName } from '../src/data/modelReader';
import { SessionFile } from '../src/types';
import { TRANSCRIPT_TAIL_BYTES, TRANSCRIPT_TAIL_MAX_BYTES } from '../src/constants';

const SESSION_ID = '6262ea69-f0c0-43c1-9bb2-000ffef8dd6c';

let claudeHome: string;

const makeSession = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  pid: 1234,
  sessionId: SESSION_ID,
  cwd: '/Users/alireza/WebstormProjects/claude-pulse',
  startedAt: 1000,
  ...overrides,
});

/** Builds an assistant record in the verified on-disk shape. */
const assistantRecord = (
  model: string | null,
  effort?: string,
  extra: Record<string, unknown> = {}
): string =>
  JSON.stringify({
    type: 'assistant',
    ...(effort === undefined ? {} : { effort }),
    isSidechain: false,
    timestamp: '2026-08-01T11:23:04.004Z',
    message: model === null ? {} : { model },
    ...extra,
  });

const userRecord = (): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });

/** Writes a transcript at the encoded project path for the given session. */
function writeTranscript(session: SessionFile, lines: string[], dirName?: string): string {
  const projectDir = path.join(
    claudeHome,
    'projects',
    dirName ?? encodeProjectDirName(session.cwd)
  );
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${session.sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
  return filePath;
}

function writeSettings(content: string): void {
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), content, 'utf-8');
}

describe('encodeProjectDirName', () => {
  it('replaces path separators with dashes', () => {
    expect(encodeProjectDirName('/Users/alireza/WebstormProjects/claude-pulse')).toBe(
      '-Users-alireza-WebstormProjects-claude-pulse'
    );
  });

  it('replaces dots with dashes (verified against real directories)', () => {
    expect(encodeProjectDirName('/Users/alireza/PycharmProjects/Skillnir/.data/research')).toBe(
      '-Users-alireza-PycharmProjects-Skillnir--data-research'
    );
  });

  it('leaves an already-dashed segment intact', () => {
    expect(encodeProjectDirName('/private/tmp/claude-502/tasks')).toBe(
      '-private-tmp-claude-502-tasks'
    );
  });
});

describe('readModelInfo', () => {
  beforeEach(() => {
    clearModelCache();
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('returns the model and effort from the last assistant record', async () => {
    const session = makeSession();
    writeTranscript(session, [
      userRecord(),
      assistantRecord('claude-opus-4-8', 'high'),
      userRecord(),
      assistantRecord('claude-opus-5', 'xhigh'),
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result).toEqual({
      model: 'claude-opus-5',
      effort: 'xhigh',
      effortSource: 'transcript',
      isSessionLive: true,
    });
  });

  it('carries session liveness through from the caller', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);

    const result = await readModelInfo(claudeHome, session, false);

    expect(result?.isSessionLive).toBe(false);
  });

  it('returns null when there is no session', async () => {
    expect(await readModelInfo(claudeHome, null, false)).toBeNull();
  });

  it('returns null when the transcript cannot be found', async () => {
    expect(await readModelInfo(claudeHome, makeSession(), true)).toBeNull();
  });

  it('skips <synthetic> records and uses the previous real model', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      assistantRecord('<synthetic>'),
      assistantRecord('<synthetic>'),
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
    expect(result?.effort).toBe('xhigh');
  });

  it('skips sidechain records', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      assistantRecord('claude-haiku-4-5-20251001', 'high', { isSidechain: true }),
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('skips records with no model on the message', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh'), assistantRecord(null)]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('skips malformed and truncated JSONL lines without throwing', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      'not json at all',
      '{"type":"assistant","message":{"model":"claude-opu',
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('falls back to settings.json effortLevel when the record has no effort key', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-4-7')]);
    writeSettings(JSON.stringify({ effortLevel: 'high', permissions: { allow: [] } }));

    const result = await readModelInfo(claudeHome, session, true);

    expect(result).toEqual({
      model: 'claude-opus-4-7',
      effort: 'high',
      effortSource: 'settings',
      isSessionLive: true,
    });
  });

  it('prefers the transcript effort over settings.json', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    writeSettings(JSON.stringify({ effortLevel: 'low' }));

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.effort).toBe('xhigh');
    expect(result?.effortSource).toBe('transcript');
  });

  it('leaves effort null when settings.json is missing', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-4-7')]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-4-7');
    expect(result?.effort).toBeNull();
    expect(result?.effortSource).toBeNull();
  });

  it('leaves effort null when settings.json is malformed', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-4-7')]);
    writeSettings('{ this is not json');

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.effort).toBeNull();
  });

  it('leaves effort null when settings.json has no effortLevel key', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-4-7')]);
    writeSettings(JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.effort).toBeNull();
  });

  it('returns effort alone when the transcript has no assistant record yet', async () => {
    const session = makeSession();
    writeTranscript(session, [userRecord(), userRecord()]);
    writeSettings(JSON.stringify({ effortLevel: 'xhigh' }));

    const result = await readModelInfo(claudeHome, session, true);

    expect(result).toEqual({
      model: null,
      effort: 'xhigh',
      effortSource: 'settings',
      isSessionLive: true,
    });
  });

  it('returns null when neither a model nor an effort can be resolved', async () => {
    const session = makeSession();
    writeTranscript(session, [userRecord()]);

    expect(await readModelInfo(claudeHome, session, true)).toBeNull();
  });

  it('finds the transcript by scanning when the cwd encoding does not match', async () => {
    const session = makeSession({ cwd: '/some/path/that/encodes/differently' });
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')], 'totally-unrelated-name');

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('reads only the tail of a large transcript', async () => {
    const session = makeSession();
    // Pad well past the tail window with records that must never be reached.
    const filler = new Array(400).fill(
      assistantRecord('claude-should-never-be-seen', 'low', { pad: 'x'.repeat(200) })
    );
    const filePath = writeTranscript(session, [
      ...filler,
      assistantRecord('claude-opus-5', 'xhigh'),
    ]);

    expect(fs.statSync(filePath).size).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES);

    const result = await readModelInfo(claudeHome, session, true);
    expect(result?.model).toBe('claude-opus-5');
  });

  it('widens the read window once when the tail holds no assistant record', async () => {
    const session = makeSession();
    // ~86 KB of trailing user records pushes the assistant record out of the 64 KB
    // window but keeps it inside the 256 KB widened window.
    const trailing = new Array(400).fill(JSON.stringify({ type: 'user', pad: 'x'.repeat(200) }));
    const filePath = writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...trailing,
    ]);
    const size = fs.statSync(filePath).size;
    expect(size).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES);
    expect(size).toBeLessThan(TRANSCRIPT_TAIL_MAX_BYTES);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('gives up rather than reading the whole file past the widening ceiling', async () => {
    const session = makeSession();
    // Beyond 256 KB of trailing records the assistant record is unreachable by design —
    // the cost ceiling matters more than resolving a pathological transcript.
    const trailing = new Array(1400).fill(JSON.stringify({ type: 'user', pad: 'x'.repeat(200) }));
    const filePath = writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...trailing,
    ]);
    expect(fs.statSync(filePath).size).toBeGreaterThan(TRANSCRIPT_TAIL_MAX_BYTES);

    expect(await readModelInfo(claudeHome, session, true)).toBeNull();
  });

  it('serves an unchanged transcript from cache without re-reading it', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');

    const openSpy = vi.spyOn(fs.promises, 'open');
    const cached = await readModelInfo(claudeHome, session, true);

    expect(cached?.model).toBe('claude-opus-5');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('re-reads after clearModelCache()', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    await readModelInfo(claudeHome, session, true);

    clearModelCache();
    const openSpy = vi.spyOn(fs.promises, 'open');
    await readModelInfo(claudeHome, session, true);

    expect(openSpy).toHaveBeenCalled();
  });

  it('picks up a new record when the transcript grows', async () => {
    const session = makeSession();
    const filePath = writeTranscript(session, [assistantRecord('claude-opus-4-8', 'high')]);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-4-8');

    fs.appendFileSync(filePath, assistantRecord('claude-opus-5', 'xhigh') + '\n', 'utf-8');

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');
  });

  it('returns null and does not throw when the transcript read fails', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    vi.spyOn(fs.promises, 'open').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(readModelInfo(claudeHome, session, true)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });
});
