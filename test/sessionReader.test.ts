import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import {
  readSessions,
  isProcessAlive,
  getActiveSessions,
  getMostRecentSession,
  findSessionForWorkspace,
} from '../src/data/sessionReader';
import { SessionFile } from '../src/types';

vi.mock('fs');

const mockReaddir = vi.mocked(fs.promises.readdir);
const mockReadFile = vi.mocked(fs.promises.readFile);

const makeSession = (overrides: Partial<SessionFile> = {}): SessionFile => ({
  pid: 1234,
  sessionId: 'abc-123',
  cwd: '/home/user/project',
  startedAt: 1000,
  ...overrides,
});

describe('readSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reads valid session files', async () => {
    const session1 = makeSession({ pid: 1, sessionId: 's1' });
    const session2 = makeSession({ pid: 2, sessionId: 's2' });

    mockReaddir.mockResolvedValue(['s1.json', 's2.json'] as any);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(session1) as any)
      .mockResolvedValueOnce(JSON.stringify(session2) as any);

    const result = await readSessions('/fake/home');
    expect(result).toEqual([session1, session2]);
    expect(mockReaddir).toHaveBeenCalledWith('/fake/home/sessions');
  });

  it('skips non-json files', async () => {
    const session = makeSession();
    mockReaddir.mockResolvedValue(['s1.json', 'notes.txt', 'readme.md'] as any);
    mockReadFile.mockResolvedValue(JSON.stringify(session) as any);

    const result = await readSessions('/fake/home');
    expect(result).toHaveLength(1);
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('skips malformed JSON files', async () => {
    const validSession = makeSession();
    mockReaddir.mockResolvedValue(['good.json', 'bad.json'] as any);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify(validSession) as any)
      .mockResolvedValueOnce('not valid json' as any);

    const result = await readSessions('/fake/home');
    expect(result).toEqual([validSession]);
  });

  it('skips sessions missing pid or sessionId', async () => {
    mockReaddir.mockResolvedValue(['nopid.json', 'nosid.json'] as any);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ sessionId: 's1', cwd: '/', startedAt: 1 }) as any)
      .mockResolvedValueOnce(JSON.stringify({ pid: 1, cwd: '/', startedAt: 1 }) as any);

    const result = await readSessions('/fake/home');
    expect(result).toEqual([]);
  });

  it('returns empty array when sessions directory does not exist', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    const result = await readSessions('/fake/home');
    expect(result).toEqual([]);
  });
});

describe('isProcessAlive', () => {
  it('returns true when process.kill(pid, 0) succeeds', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isProcessAlive(1234)).toBe(true);
    expect(spy).toHaveBeenCalledWith(1234, 0);
    spy.mockRestore();
  });

  it('returns false when process.kill(pid, 0) throws', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    expect(isProcessAlive(9999)).toBe(false);
    expect(spy).toHaveBeenCalledWith(9999, 0);
    spy.mockRestore();
  });
});

describe('getActiveSessions', () => {
  it('filters sessions to only those with alive processes', () => {
    const sessions = [
      makeSession({ pid: 100, sessionId: 'alive' }),
      makeSession({ pid: 200, sessionId: 'dead' }),
      makeSession({ pid: 300, sessionId: 'alive2' }),
    ];

    const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 200) throw new Error('ESRCH');
      return true;
    });

    const result = getActiveSessions(sessions);
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.sessionId)).toEqual(['alive', 'alive2']);
    spy.mockRestore();
  });

  it('returns empty array when no sessions are alive', () => {
    const sessions = [makeSession({ pid: 1 }), makeSession({ pid: 2 })];
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    const result = getActiveSessions(sessions);
    expect(result).toEqual([]);
    spy.mockRestore();
  });
});

describe('getMostRecentSession', () => {
  it('returns the session with the highest startedAt value', () => {
    const sessions = [
      makeSession({ sessionId: 'old', startedAt: 100 }),
      makeSession({ sessionId: 'newest', startedAt: 300 }),
      makeSession({ sessionId: 'mid', startedAt: 200 }),
    ];

    const result = getMostRecentSession(sessions);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('newest');
  });

  it('returns null for an empty array', () => {
    expect(getMostRecentSession([])).toBeNull();
  });

  it('returns the only session when array has one element', () => {
    const session = makeSession({ sessionId: 'only' });
    expect(getMostRecentSession([session])).toEqual(session);
  });
});

describe('findSessionForWorkspace', () => {
  it('prefers the session matching the workspace over the first one on disk', () => {
    const sessions = [
      makeSession({ sessionId: 'other-project', cwd: '/home/user/other', startedAt: 100 }),
      makeSession({ sessionId: 'mine', cwd: '/home/user/project', startedAt: 200 }),
    ];

    const result = findSessionForWorkspace(sessions, ['/home/user/project']);
    expect(result?.sessionId).toBe('mine');
  });

  it('matches a session started in a subdirectory of the workspace', () => {
    const sessions = [makeSession({ sessionId: 'nested', cwd: '/home/user/project/src/data' })];

    expect(findSessionForWorkspace(sessions, ['/home/user/project'])?.sessionId).toBe('nested');
  });

  it('prefers an exact match over a merely-contained one', () => {
    const sessions = [
      makeSession({ sessionId: 'nested', cwd: '/home/user/project/src', startedAt: 500 }),
      makeSession({ sessionId: 'exact', cwd: '/home/user/project', startedAt: 100 }),
    ];

    expect(findSessionForWorkspace(sessions, ['/home/user/project'])?.sessionId).toBe('exact');
  });

  it('picks the deepest workspace folder in a multi-root workspace', () => {
    const sessions = [makeSession({ sessionId: 'deep', cwd: '/home/user/project/packages/app' })];

    const result = findSessionForWorkspace(sessions, [
      '/home/user/project',
      '/home/user/project/packages/app',
    ]);
    expect(result?.sessionId).toBe('deep');
  });

  it('breaks ties toward the most recently started session', () => {
    const sessions = [
      makeSession({ sessionId: 'older', cwd: '/home/user/project', startedAt: 100 }),
      makeSession({ sessionId: 'newer', cwd: '/home/user/project', startedAt: 900 }),
      makeSession({ sessionId: 'middle', cwd: '/home/user/project', startedAt: 400 }),
    ];

    expect(findSessionForWorkspace(sessions, ['/home/user/project'])?.sessionId).toBe('newer');
  });

  it('ignores a trailing separator on the workspace path', () => {
    const sessions = [makeSession({ sessionId: 'mine', cwd: '/home/user/project' })];

    expect(findSessionForWorkspace(sessions, ['/home/user/project/'])?.sessionId).toBe('mine');
  });

  it('does not treat a sibling with a shared prefix as a match', () => {
    const sessions = [makeSession({ sessionId: 'sibling', cwd: '/home/user/project-other' })];

    expect(findSessionForWorkspace(sessions, ['/home/user/project'])).toBeNull();
  });

  it('returns null when no session belongs to the workspace', () => {
    const sessions = [makeSession({ cwd: '/home/user/elsewhere' })];

    expect(findSessionForWorkspace(sessions, ['/home/user/project'])).toBeNull();
  });

  it('returns null for empty sessions or empty workspace paths', () => {
    expect(findSessionForWorkspace([], ['/home/user/project'])).toBeNull();
    expect(findSessionForWorkspace([makeSession()], [])).toBeNull();
  });

  it('skips sessions with no cwd rather than throwing', () => {
    const sessions = [
      makeSession({ sessionId: 'no-cwd', cwd: undefined as unknown as string }),
      makeSession({ sessionId: 'mine', cwd: '/home/user/project' }),
    ];

    expect(findSessionForWorkspace(sessions, ['/home/user/project'])?.sessionId).toBe('mine');
  });
});
