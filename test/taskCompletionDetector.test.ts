import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { TaskCompletionDetector } from '../src/data/taskCompletionDetector';

vi.mock('fs');

const mockedFs = vi.mocked(fs);

function makeEndTurnEvent(timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn' },
    timestamp,
  });
}

function makeToolUseEvent(timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'tool_use' },
    timestamp,
  });
}

function makeUserEvent(timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'hello' },
    timestamp,
  });
}

describe('TaskCompletionDetector', () => {
  let detector: TaskCompletionDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();

    // Mock readdirSync to return a project directory
    mockedFs.readdirSync = vi.fn().mockReturnValue(['project-dir']);

    // Mock existsSync to find the JSONL file
    mockedFs.existsSync = vi.fn().mockReturnValue(true);

    // Mock statSync — initial file size 0
    mockedFs.statSync = vi.fn().mockReturnValue({ size: 0 });

    // Mock openSync/readSync/closeSync for readNewBytes
    mockedFs.openSync = vi.fn().mockReturnValue(42);
    mockedFs.readSync = vi.fn().mockReturnValue(0);
    mockedFs.closeSync = vi.fn();
  });

  afterEach(() => {
    detector?.dispose();
    vi.useRealTimers();
  });

  it('should fire onTaskCompleted when end_turn is followed by idle period', () => {
    detector = new TaskCompletionDetector(1); // 1 second idle threshold for fast test

    const completedEvents: { sessionId: string; cwd: string }[] = [];
    detector.onTaskCompleted((e) => completedEvents.push(e));

    // Register a session
    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );

    // Simulate file growing with end_turn content
    const endTurnLine = makeEndTurnEvent('2026-03-30T12:00:00Z') + '\n';
    mockedFs.statSync = vi.fn().mockReturnValue({ size: endTurnLine.length });
    mockedFs.readSync = vi.fn().mockImplementation((_fd, buffer: Buffer) => {
      buffer.write(endTurnLine);
      return endTurnLine.length;
    });

    // Advance past poll interval (2s)
    vi.advanceTimersByTime(2100);

    // Not fired yet — idle timer still running
    expect(completedEvents).toHaveLength(0);

    // Advance past idle threshold (1s)
    vi.advanceTimersByTime(1100);

    // Now it should have fired
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].sessionId).toBe('sess-1');
  });

  it('should NOT fire when tool_use is the last event', () => {
    detector = new TaskCompletionDetector(1);

    const completedEvents: { sessionId: string; cwd: string }[] = [];
    detector.onTaskCompleted((e) => completedEvents.push(e));

    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );

    // Simulate tool_use event
    const toolUseLine = makeToolUseEvent('2026-03-30T12:00:00Z') + '\n';
    mockedFs.statSync = vi.fn().mockReturnValue({ size: toolUseLine.length });
    mockedFs.readSync = vi.fn().mockImplementation((_fd, buffer: Buffer) => {
      buffer.write(toolUseLine);
      return toolUseLine.length;
    });

    // Advance past poll + idle
    vi.advanceTimersByTime(5000);

    expect(completedEvents).toHaveLength(0);
  });

  it('should cancel idle timer when new activity appears', () => {
    detector = new TaskCompletionDetector(2); // 2 second idle

    const completedEvents: { sessionId: string; cwd: string }[] = [];
    detector.onTaskCompleted((e) => completedEvents.push(e));

    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );

    // First: end_turn event
    const endTurnLine = makeEndTurnEvent('2026-03-30T12:00:00Z') + '\n';
    let currentSize = endTurnLine.length;
    mockedFs.statSync = vi.fn().mockReturnValue({ size: currentSize });
    mockedFs.readSync = vi.fn().mockImplementation((_fd, buffer: Buffer) => {
      buffer.write(endTurnLine);
      return endTurnLine.length;
    });

    // Poll picks up end_turn
    vi.advanceTimersByTime(2100);
    expect(completedEvents).toHaveLength(0); // timer started but not fired

    // Before idle timer fires, new user event appears
    const userLine = makeUserEvent('2026-03-30T12:00:01Z') + '\n';
    currentSize += userLine.length;
    mockedFs.statSync = vi.fn().mockReturnValue({ size: currentSize });
    mockedFs.readSync = vi.fn().mockImplementation((_fd, buffer: Buffer) => {
      buffer.write(userLine);
      return userLine.length;
    });

    // Poll picks up new activity — should cancel the idle timer
    vi.advanceTimersByTime(2100);

    // Advance well past idle threshold
    vi.advanceTimersByTime(5000);

    // Should NOT have fired because user activity cancelled it
    expect(completedEvents).toHaveLength(0);
  });

  it('should respect cooldown between notifications', () => {
    detector = new TaskCompletionDetector(1);

    const completedEvents: { sessionId: string; cwd: string }[] = [];
    detector.onTaskCompleted((e) => completedEvents.push(e));

    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );

    // First end_turn
    const line1 = makeEndTurnEvent('2026-03-30T12:00:00Z') + '\n';
    let currentSize = line1.length;
    mockedFs.statSync = vi.fn().mockReturnValue({ size: currentSize });
    mockedFs.readSync = vi.fn().mockImplementation((_fd, buffer: Buffer) => {
      buffer.write(line1);
      return line1.length;
    });

    vi.advanceTimersByTime(2100); // poll
    vi.advanceTimersByTime(1100); // idle fires
    expect(completedEvents).toHaveLength(1);

    // Second end_turn immediately after (within cooldown)
    const line2 = makeEndTurnEvent('2026-03-30T12:00:05Z') + '\n';
    currentSize += line2.length;
    mockedFs.statSync = vi.fn().mockReturnValue({ size: currentSize });
    mockedFs.readSync = vi.fn().mockImplementation((_fd, buffer: Buffer) => {
      buffer.write(line2);
      return line2.length;
    });

    vi.advanceTimersByTime(2100); // poll
    vi.advanceTimersByTime(1100); // idle fires — but cooldown should block

    // Still only 1 notification due to 30s cooldown
    expect(completedEvents).toHaveLength(1);
  });

  it('should clean up watchers when sessions are removed', () => {
    detector = new TaskCompletionDetector(1);

    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );

    // Remove the session
    detector.updateSessions([], '/home/user/.claude');

    // Simulate file change — should not crash or fire
    const line = makeEndTurnEvent('2026-03-30T12:00:00Z') + '\n';
    mockedFs.statSync = vi.fn().mockReturnValue({ size: line.length });

    vi.advanceTimersByTime(5000);
    // No error = success
  });

  it('should handle missing JSONL file gracefully', () => {
    detector = new TaskCompletionDetector(1);

    // existsSync returns false — no JSONL found
    mockedFs.existsSync = vi.fn().mockReturnValue(false);

    // Should not throw
    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );
  });

  it('should dispose cleanly', () => {
    detector = new TaskCompletionDetector(1);

    detector.updateSessions(
      [{ pid: 123, sessionId: 'sess-1', cwd: '/test/project', startedAt: Date.now() }],
      '/home/user/.claude'
    );

    expect(() => detector.dispose()).not.toThrow();
  });
});
