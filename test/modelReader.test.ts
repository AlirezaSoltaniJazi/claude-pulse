import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readModelInfo,
  clearModelCache,
  classifySelection,
  encodeProjectDirName,
  resolveEffort,
  resolveModelSelection,
  resolveTranscriptPath,
} from '../src/data/modelReader';
import { SessionFile } from '../src/types';
import { TRANSCRIPT_TAIL_BYTES } from '../src/constants';

const SESSION_ID = '6262ea69-f0c0-43c1-9bb2-000ffef8dd6c';

/** All transcript fixtures are stamped here; settings.json defaults to an hour earlier. */
const TRANSCRIPT_AT = '2026-08-01T11:23:04.004Z';
const SETTINGS_OLDER_MS = Date.parse('2026-08-01T10:00:00.000Z');
const SETTINGS_NEWER_MS = Date.parse('2026-08-01T12:00:00.000Z');

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
    timestamp: TRANSCRIPT_AT,
    message: model === null ? {} : { model },
    ...extra,
  });

const userRecord = (): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });

/**
 * A `/model` invocation writes two records; only the stdout one carries the resolved id.
 * Copied verbatim in shape from real records in ~/.claude/projects.
 */
const modelCommandRecords = (
  resolved: string | null,
  args: string = 'default',
  timestamp: string = TRANSCRIPT_AT,
  extra: Record<string, unknown> = {}
): string[] => {
  const invocation = JSON.stringify({
    type: 'user',
    isSidechain: false,
    timestamp,
    message: {
      role: 'user',
      content: `<command-name>/model</command-name> <command-message>model</command-message> <command-args>${args}</command-args>`,
    },
    ...extra,
  });
  if (resolved === null) return [invocation];
  return [
    invocation,
    JSON.stringify({
      type: 'user',
      isSidechain: false,
      timestamp,
      message: {
        role: 'user',
        content: `<local-command-stdout>Set model to ${resolved}</local-command-stdout>`,
      },
      ...extra,
    }),
  ];
};

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

/**
 * Advances the transcript mtime the way a real append does. Size alone would invalidate the
 * evidence cache, but a rewrite can leave the size unchanged, so mtime has to move too.
 */
let touchCounter = 0;
function touchTranscript(filePath: string): void {
  const at = new Date(Date.parse(TRANSCRIPT_AT) + ++touchCounter * 1000);
  fs.utimesSync(filePath, at, at);
}

/**
 * settings.json is dated explicitly rather than "whenever the test happened to run": the
 * resolution rules compare its mtime against transcript timestamps, so a real wall-clock
 * mtime would make these tests depend on the day they are run.
 */
function writeSettings(content: string, mtimeMs: number = SETTINGS_OLDER_MS): void {
  fs.mkdirSync(claudeHome, { recursive: true });
  const filePath = path.join(claudeHome, 'settings.json');
  fs.writeFileSync(filePath, content, 'utf-8');
  fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
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
      modelSource: 'transcript',
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

  it('returns null when there is neither a transcript nor a settings.json', async () => {
    expect(await readModelInfo(claudeHome, makeSession(), true)).toBeNull();
  });

  it('falls back to the settings.json selection when no transcript exists yet', async () => {
    // A brand-new session writes no transcript for ~100s. Rendering nothing in that window
    // makes the status bar segment vanish, which reads as the feature being broken.
    writeSettings(
      JSON.stringify({ model: 'claude-fable-5[1m]', effortLevel: 'xhigh' }),
      SETTINGS_NEWER_MS
    );

    const result = await readModelInfo(claudeHome, makeSession(), true);

    expect(result).toEqual({
      model: 'claude-fable-5[1m]',
      modelSource: 'settings',
      effort: 'xhigh',
      effortSource: 'settings',
      isSessionLive: true,
    });
  });

  it('still falls back to settings.json when the transcript vanishes mid-read', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'sonnet', effortLevel: 'low' }), SETTINGS_NEWER_MS);
    clearModelCache();
    // Only the transcript read fails; settings.json is still readable.
    vi.spyOn(fs.promises, 'open').mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('sonnet');
    expect(result?.modelSource).toBe('settings');
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
      modelSource: 'transcript',
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
      modelSource: null,
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

  it('widens the read window when the tail holds no assistant record', async () => {
    const session = makeSession();
    // ~86 KB of trailing user records pushes the assistant record out of the 64 KB window.
    const trailing = new Array(400).fill(JSON.stringify({ type: 'user', pad: 'x'.repeat(200) }));
    const filePath = writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...trailing,
    ]);
    expect(fs.statSync(filePath).size).toBeGreaterThan(TRANSCRIPT_TAIL_BYTES);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('finds the model behind a single tool result larger than any small tail window', async () => {
    // Not hypothetical: across the 113 local transcripts over 200 KB the largest single line
    // is 846 KB. Mid-turn that line sits after the last assistant record, so a fixed 256 KB
    // ceiling made the model vanish from the status bar for the whole turn.
    const session = makeSession();
    const hugeToolResult = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x'.repeat(900 * 1024) }],
      },
    });
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh'), hugeToolResult]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
  });

  it('keeps a resolved model when what follows it exceeds the widening ceiling', async () => {
    // Deliberately past the top of TRANSCRIPT_TAIL_WINDOWS, so widening alone cannot reach
    // back to the assistant record — only the incremental append-only scan can, by keeping
    // what it already proved. Evidence does not stop being true because a large record landed
    // after it, and this is what stops the model flickering off whenever Claude runs a
    // command with a big output.
    const session = makeSession();
    const filePath = writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');

    const beyondCeiling = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'x'.repeat(5 * 1024 * 1024) }],
      },
    });
    fs.appendFileSync(filePath, beyondCeiling + '\n', 'utf-8');
    touchTranscript(filePath);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');
  });

  it('picks up a record that was only half-written at the previous read', async () => {
    // The cursor stops at the last complete line, so the partial record is re-read whole
    // rather than being consumed as garbage and skipped forever.
    const session = makeSession();
    const filePath = writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    fs.appendFileSync(filePath, '{"type":"assistant","message":{"model":"claude-fab', 'utf-8');
    touchTranscript(filePath);
    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');

    fs.appendFileSync(filePath, 'le-5"},"timestamp":"' + TRANSCRIPT_AT + '"}\n', 'utf-8');
    touchTranscript(filePath);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-fable-5');
  });

  it('re-scans from scratch when the transcript is rewritten smaller', async () => {
    // A shrink means the append-only assumption is void, so the cursor and the evidence
    // behind it must both be discarded rather than trusted.
    const session = makeSession();
    const filePath = writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      userRecord(),
      userRecord(),
    ]);
    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');

    fs.writeFileSync(filePath, assistantRecord('claude-fable-5', 'high') + '\n', 'utf-8');
    touchTranscript(filePath);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-fable-5');
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

describe('classifySelection', () => {
  it('returns null for values that do not name a model', () => {
    expect(classifySelection(undefined)).toBeNull();
    expect(classifySelection(null)).toBeNull();
    expect(classifySelection('')).toBeNull();
    expect(classifySelection('   ')).toBeNull();
    // 'default' resolves server-side and 'opusplan' is a routing mode.
    expect(classifySelection('default')).toBeNull();
    expect(classifySelection('opusplan')).toBeNull();
  });

  it('classifies a bare family name as an alias', () => {
    expect(classifySelection('opus')).toEqual({ kind: 'alias', family: 'opus', raw: 'opus' });
    expect(classifySelection('opus[1m]')).toEqual({
      kind: 'alias',
      family: 'opus',
      raw: 'opus[1m]',
    });
    expect(classifySelection('haiku')).toEqual({ kind: 'alias', family: 'haiku', raw: 'haiku' });
    expect(classifySelection('sonnet')).toEqual({ kind: 'alias', family: 'sonnet', raw: 'sonnet' });
  });

  it('classifies a versioned id as a full selection', () => {
    expect(classifySelection('claude-opus-5')).toEqual({ kind: 'full', raw: 'claude-opus-5' });
    expect(classifySelection('claude-fable-5[1m]')).toEqual({
      kind: 'full',
      raw: 'claude-fable-5[1m]',
    });
    expect(classifySelection('claude-haiku-4-5-20251001')).toEqual({
      kind: 'full',
      raw: 'claude-haiku-4-5-20251001',
    });
  });
});

describe('resolveModelSelection', () => {
  const transcript = (model: string | null, at: number = 1000) => ({
    model,
    at,
    source: model ? ('transcript' as const) : null,
  });

  it('keeps the transcript value when settings.json is older than it', () => {
    expect(
      resolveModelSelection(transcript('claude-opus-5', 2000), {
        model: 'claude-fable-5[1m]',
        at: 1000,
      })
    ).toEqual({ model: 'claude-opus-5', source: 'transcript' });
  });

  it('keeps the transcript id when a newer alias agrees on the family', () => {
    // The live case: settings says 'opus[1m]', the session last ran claude-opus-5. Showing
    // the bare alias would lose the version for no reason.
    expect(
      resolveModelSelection(transcript('claude-opus-5', 1000), { model: 'opus[1m]', at: 2000 })
    ).toEqual({ model: 'claude-opus-5', source: 'transcript' });
  });

  it('adopts a newer alias when the families differ', () => {
    expect(
      resolveModelSelection(transcript('claude-haiku-4-5-20251001', 1000), {
        model: 'opus[1m]',
        at: 2000,
      })
    ).toEqual({ model: 'opus[1m]', source: 'settings' });
  });

  it('adopts a newer full id that differs from the last turn (the reported bug)', () => {
    expect(
      resolveModelSelection(transcript('claude-sonnet-5', 1000), {
        model: 'claude-fable-5[1m]',
        at: 2000,
      })
    ).toEqual({ model: 'claude-fable-5[1m]', source: 'settings' });
  });

  it('keeps the transcript value when a newer full id renders identically', () => {
    expect(
      resolveModelSelection(transcript('claude-opus-5', 1000), {
        model: 'claude-opus-5[1m]',
        at: 2000,
      })
    ).toEqual({ model: 'claude-opus-5', source: 'transcript' });
  });

  it('ignores selectors that do not name a model, however new they are', () => {
    for (const model of ['default', 'opusplan', '', null]) {
      expect(resolveModelSelection(transcript('claude-opus-5', 1000), { model, at: 9999 })).toEqual(
        {
          model: 'claude-opus-5',
          source: 'transcript',
        }
      );
    }
  });

  it('adopts the selection when the transcript has no model at all', () => {
    expect(resolveModelSelection(transcript(null), { model: 'opus[1m]', at: 2000 })).toEqual({
      model: 'opus[1m]',
      source: 'settings',
    });
  });

  it('reports no model when neither source has one', () => {
    expect(resolveModelSelection(transcript(null), { model: null, at: 2000 })).toEqual({
      model: null,
      source: null,
    });
  });

  it('lets settings win when the transcript record carried no timestamp (residual R4)', () => {
    // Documented residual: an undated record cannot defend itself against a dated file.
    expect(
      resolveModelSelection(transcript('claude-sonnet-5', 0), { model: 'claude-fable-5', at: 1 })
    ).toEqual({ model: 'claude-fable-5', source: 'settings' });
  });

  it('preserves a command source when the transcript wins', () => {
    expect(
      resolveModelSelection(
        { model: 'claude-fable-5', at: 2000, source: 'command' },
        { model: 'claude-opus-5', at: 1000 }
      )
    ).toEqual({ model: 'claude-fable-5', source: 'command' });
  });
});

describe('resolveEffort', () => {
  it('falls back to settings when the transcript record has no effort', () => {
    expect(
      resolveEffort({ effort: null, at: 2000 }, { effortLevel: 'high', at: 1000 }, true)
    ).toEqual({ effort: 'high', effortSource: 'settings' });
  });

  it('reports nothing when neither source has an effort', () => {
    expect(resolveEffort({ effort: null, at: 0 }, { effortLevel: null, at: 0 }, true)).toEqual({
      effort: null,
      effortSource: null,
    });
  });

  it('prefers the transcript effort when it is newer than settings', () => {
    expect(
      resolveEffort({ effort: 'xhigh', at: 2000 }, { effortLevel: 'low', at: 1000 }, true)
    ).toEqual({ effort: 'xhigh', effortSource: 'transcript' });
  });

  it('adopts a newer settings effort for a live session', () => {
    expect(
      resolveEffort({ effort: 'xhigh', at: 1000 }, { effortLevel: 'low', at: 2000 }, true)
    ).toEqual({ effort: 'low', effortSource: 'settings' });
  });

  it('never adopts a newer settings effort for a dead session', () => {
    // A process that is gone cannot have made the selection that settings.json records.
    expect(
      resolveEffort({ effort: 'xhigh', at: 1000 }, { effortLevel: 'low', at: 2000 }, false)
    ).toEqual({ effort: 'xhigh', effortSource: 'transcript' });
  });
});

describe('readModelInfo model attribution', () => {
  beforeEach(() => {
    clearModelCache();
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('prefers a /model record that lands after the last assistant turn', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...modelCommandRecords('claude-fable-5', 'fable', '2026-08-01T11:30:00.000Z'),
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-fable-5');
    expect(result?.modelSource).toBe('command');
    // Effort still comes from the assistant record — /effort writes no transcript record.
    expect(result?.effort).toBe('xhigh');
    expect(result?.effortSource).toBe('transcript');
  });

  it('lets an assistant turn after the /model record confirm and win', async () => {
    const session = makeSession();
    writeTranscript(session, [
      ...modelCommandRecords('claude-fable-5', 'fable', '2026-08-01T11:00:00.000Z'),
      assistantRecord('claude-fable-5', 'xhigh'),
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-fable-5');
    expect(result?.modelSource).toBe('transcript');
  });

  it('ignores a cancelled picker, which writes no stdout record', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...modelCommandRecords(null, '', '2026-08-01T11:30:00.000Z'),
    ]);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
    expect(result?.modelSource).toBe('transcript');
  });

  it('ignores a /model stdout value that does not name a model', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...modelCommandRecords('default', 'default', '2026-08-01T11:30:00.000Z'),
    ]);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');
  });

  it('ignores a /model record from a sidechain', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      ...modelCommandRecords('claude-fable-5', 'fable', '2026-08-01T11:30:00.000Z', {
        isSidechain: true,
      }),
    ]);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');
  });

  it('survives a user record whose content is an array rather than a string', async () => {
    const session = makeSession();
    writeTranscript(session, [
      assistantRecord('claude-opus-5', 'xhigh'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-01T11:30:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'Set model to x' }] },
      }),
    ]);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');
  });

  it('adopts a newer global selection the session has not confirmed yet', async () => {
    // The reported bug: switch model, no turn since, the bar stayed on the old model.
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-sonnet-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'claude-fable-5[1m]' }), SETTINGS_NEWER_MS);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-fable-5[1m]');
    expect(result?.modelSource).toBe('settings');
  });

  it('keeps this session on its own model when a newer alias agrees on the family', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'opus[1m]' }), SETTINGS_NEWER_MS);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
    expect(result?.modelSource).toBe('transcript');
  });

  it('ignores a global selection older than this session activity', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'claude-fable-5[1m]' }), SETTINGS_OLDER_MS);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-opus-5');
    expect(result?.modelSource).toBe('transcript');
  });

  it('never adopts a global selection for a session that is no longer live', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-sonnet-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'claude-fable-5[1m]' }), SETTINGS_NEWER_MS);

    const result = await readModelInfo(claudeHome, session, false);

    expect(result?.model).toBe('claude-sonnet-5');
    expect(result?.modelSource).toBe('transcript');
  });

  it('adopts a newer global effort level', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-opus-5', 'xhigh')]);
    writeSettings(JSON.stringify({ effortLevel: 'low' }), SETTINGS_NEWER_MS);

    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.effort).toBe('low');
    expect(result?.effortSource).toBe('settings');
  });

  it('picks up a settings.json rewrite without waiting for the transcript to change', async () => {
    // The cache is keyed on settings.json's mtime, not a TTL. Without that, a /model switch
    // in an idle session would not surface until the model cache expired.
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-sonnet-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'claude-opus-5' }), SETTINGS_NEWER_MS);

    expect((await readModelInfo(claudeHome, session, true))?.model).toBe('claude-opus-5');

    writeSettings(JSON.stringify({ model: 'claude-fable-5[1m]' }), SETTINGS_NEWER_MS + 1000);

    const result = await readModelInfo(claudeHome, session, true);
    expect(result?.model).toBe('claude-fable-5[1m]');
    expect(result?.modelSource).toBe('settings');
  });

  it('does not re-read the transcript when only settings.json changed', async () => {
    const session = makeSession();
    writeTranscript(session, [assistantRecord('claude-sonnet-5', 'xhigh')]);
    writeSettings(JSON.stringify({ model: 'claude-opus-5' }), SETTINGS_NEWER_MS);
    await readModelInfo(claudeHome, session, true);

    writeSettings(JSON.stringify({ model: 'claude-fable-5[1m]' }), SETTINGS_NEWER_MS + 1000);
    const openSpy = vi.spyOn(fs.promises, 'open');
    const result = await readModelInfo(claudeHome, session, true);

    expect(result?.model).toBe('claude-fable-5[1m]');
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('resolveTranscriptPath', () => {
  beforeEach(() => {
    clearModelCache();
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(claudeHome, { recursive: true, force: true });
  });

  it('resolves via the encoded-path probe without scanning', async () => {
    const session = makeSession();
    const expected = writeTranscript(session, [assistantRecord('claude-opus-5')]);
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');

    expect(await resolveTranscriptPath(claudeHome, session)).toBe(expected);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('falls back to a directory scan when the encoding does not match', async () => {
    const session = makeSession({ cwd: '/some/path/that/encodes/differently' });
    const expected = writeTranscript(session, [assistantRecord('claude-opus-5')], 'unrelated-name');

    expect(await resolveTranscriptPath(claudeHome, session)).toBe(expected);
  });

  it('returns null when no transcript exists and never throws', async () => {
    expect(await resolveTranscriptPath(claudeHome, makeSession())).toBeNull();
  });

  it('caches the resolution, including a null one', async () => {
    const session = makeSession();
    expect(await resolveTranscriptPath(claudeHome, session)).toBeNull();

    const readdirSpy = vi.spyOn(fs.promises, 'readdir');
    expect(await resolveTranscriptPath(claudeHome, session)).toBeNull();
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});
