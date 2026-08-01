import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileWatcher } from '../src/data/fileWatcher';
import { MODEL_WATCH_DEBOUNCE_MS } from '../src/constants';

/**
 * The settings poll is driven at 25ms so the poll path — not FSEvents, whose delivery latency
 * is not something a test should depend on — decides when these assertions resolve. The tests
 * that deliberately exercise fs.watch say so and are given a longer timeout.
 */
const POLL_MS = 25;
/** Comfortably past the debounce, so a coalesced burst has certainly landed. */
const SETTLE_MS = MODEL_WATCH_DEBOUNCE_MS + 250;

let home: string;
let watcher: FileWatcher | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Counts firings of one event, so assertions can talk about deltas rather than order. */
function counterFor(subscribe: (listener: () => void) => unknown): { count: number } {
  const state = { count: 0 };
  subscribe(() => {
    state.count++;
  });
  return state;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for condition');
}

function settingsPath(): string {
  return path.join(home, 'settings.json');
}

/** Writes settings.json with an explicit mtime, so mtime advance is never left to chance. */
function writeSettings(model: string, mtimeMs: number): void {
  fs.writeFileSync(settingsPath(), JSON.stringify({ model }), 'utf-8');
  fs.utimesSync(settingsPath(), new Date(mtimeMs), new Date(mtimeMs));
}

function writeTranscript(name: string, lines: number = 1): string {
  const filePath = path.join(home, `${name}.jsonl`);
  fs.writeFileSync(filePath, '{"type":"user"}\n'.repeat(lines), 'utf-8');
  return filePath;
}

/**
 * fs.watch does not deliver events for changes made in the same tick it was registered in —
 * measured on macOS. Production arms the watch once and sees appends seconds later, so this
 * delay only reproduces the real ordering; it is not a workaround for a defect.
 */
const ARM_MS = 300;

/** Starts the watcher and waits out the first settings report, so tests can measure deltas. */
async function startAndDrain(counter: { count: number }): Promise<void> {
  watcher!.start();
  // start() reports the settings file it finds rather than silently adopting its mtime: that
  // is what guarantees a /model issued during activation is never missed.
  await waitUntil(() => counter.count >= 1);
  await sleep(SETTLE_MS);
}

describe('FileWatcher', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-watcher-'));
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    watcher?.dispose();
    watcher = null;
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('settings.json', () => {
    it('reports the settings file it finds at start-up', async () => {
      writeSettings('claude-opus-5', Date.now());
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));

      watcher.start();

      await waitUntil(() => settings.count >= 1);
    });

    it('fires when settings.json is rewritten in place', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      writeSettings('claude-fable-5[1m]', base + 5_000);

      await waitUntil(() => settings.count > before);
    });

    it('fires when settings.json is replaced by an atomic write (temp + rename)', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      // The write style that kills a naive file-level fs.watch: the inode is replaced.
      const temp = path.join(home, 'settings.json.tmp');
      fs.writeFileSync(temp, JSON.stringify({ model: 'claude-fable-5[1m]' }), 'utf-8');
      fs.utimesSync(temp, new Date(base + 5_000), new Date(base + 5_000));
      fs.renameSync(temp, settingsPath());

      await waitUntil(() => settings.count > before);
    });

    it('coalesces a burst of rewrites into a single event', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      for (let i = 1; i <= 5; i++) {
        writeSettings(`claude-opus-${i}`, base + i * 1_000);
      }

      await waitUntil(() => settings.count > before);
      await sleep(SETTLE_MS);
      expect(settings.count).toBe(before + 1);
    });

    it('ignores changes to unrelated files in the claude home directory', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      fs.writeFileSync(path.join(home, 'stats-cache.json'), '{}', 'utf-8');
      fs.writeFileSync(path.join(home, '.credentials.json'), '{}', 'utf-8');

      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(before);
    });

    it('ignores a rewrite that leaves the mtime unchanged', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      writeSettings('claude-fable-5[1m]', base); // same mtime as the initial write

      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(before);
    });

    it('stays silent when settings.json never exists', async () => {
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));

      watcher.start();

      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(0);
    });
  });

  describe('transcript', () => {
    it('fires when the watched transcript is appended to', { timeout: 10_000 }, async () => {
      const transcript = writeTranscript('session-a');
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      watcher.start();
      watcher.watchTranscript(transcript);
      await sleep(ARM_MS);

      fs.appendFileSync(transcript, '{"type":"assistant"}\n', 'utf-8');

      await waitUntil(() => transcripts.count >= 1);
    });

    it('does not fire when the transcript is only read', { timeout: 10_000 }, async () => {
      const transcript = writeTranscript('session-a');
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      watcher.start();
      watcher.watchTranscript(transcript);
      await sleep(ARM_MS);

      // This is the loop guard: the handler for this event reads the transcript, so a read
      // that produced an event would re-trigger the watcher forever.
      for (let i = 0; i < 5; i++) {
        fs.readFileSync(transcript, 'utf-8');
        await sleep(20);
      }

      await sleep(SETTLE_MS * 2);
      expect(transcripts.count).toBe(0);
    });

    it('follows a re-target and abandons the old path', { timeout: 10_000 }, async () => {
      const a = writeTranscript('session-a');
      const b = writeTranscript('session-b');
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      watcher.start();
      watcher.watchTranscript(a);
      watcher.watchTranscript(b);
      await sleep(ARM_MS);

      fs.appendFileSync(a, '{"type":"assistant"}\n', 'utf-8');
      await sleep(SETTLE_MS * 2);
      expect(transcripts.count).toBe(0);

      fs.appendFileSync(b, '{"type":"assistant"}\n', 'utf-8');
      await waitUntil(() => transcripts.count >= 1);
    });

    it('re-arming on the same path does not double up', { timeout: 10_000 }, async () => {
      const transcript = writeTranscript('session-a');
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      watcher.start();
      for (let i = 0; i < 4; i++) watcher.watchTranscript(transcript);
      await sleep(ARM_MS);

      fs.appendFileSync(transcript, '{"type":"assistant"}\n', 'utf-8');

      await waitUntil(() => transcripts.count >= 1);
      await sleep(SETTLE_MS);
      expect(transcripts.count).toBe(1);
    });

    it('tears down on watchTranscript(null)', { timeout: 10_000 }, async () => {
      const transcript = writeTranscript('session-a');
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      watcher.start();
      watcher.watchTranscript(transcript);
      watcher.watchTranscript(null);
      await sleep(ARM_MS);

      fs.appendFileSync(transcript, '{"type":"assistant"}\n', 'utf-8');

      await sleep(SETTLE_MS * 2);
      expect(transcripts.count).toBe(0);
    });

    it('survives being pointed at a transcript that does not exist', async () => {
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      watcher.start();

      expect(() => watcher!.watchTranscript(path.join(home, 'missing.jsonl'))).not.toThrow();
    });

    it('does not report arming on an existing transcript as a change', async () => {
      // The poll would otherwise treat every re-target as news, because arming resets the
      // mtime/size baseline. Arming is not a change; only what happens afterwards is.
      const transcript = writeTranscript('session-a', 3);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      watcher.start();

      watcher.watchTranscript(transcript);

      await sleep(SETTLE_MS * 2);
      expect(transcripts.count).toBe(0);
    });

    it(
      'reports an append after the transcript inode is replaced',
      { timeout: 10_000 },
      async () => {
        // The file-level fs.watch dies permanently when a rewrite or compaction swaps the inode,
        // and nothing else re-reads the transcript on a timer — so without the poll the model
        // would freeze here for the rest of the session. Appends below reach the NEW inode,
        // which the original watcher cannot see: only the poll can deliver them.
        const transcript = writeTranscript('session-a');
        watcher = new FileWatcher(home, 60_000, POLL_MS);
        const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
        watcher.start();
        watcher.watchTranscript(transcript);
        await sleep(ARM_MS);

        const temp = path.join(home, 'session-a.jsonl.tmp');
        fs.writeFileSync(temp, '{"type":"user"}\n{"type":"user"}\n', 'utf-8');
        fs.renameSync(temp, transcript);
        await sleep(SETTLE_MS * 2);

        const before = transcripts.count;
        fs.appendFileSync(transcript, '{"type":"assistant"}\n', 'utf-8');

        await waitUntil(() => transcripts.count > before);
      }
    );
  });

  describe('claudeHomePath changes', () => {
    let otherHome: string;

    beforeEach(() => {
      otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-watcher-alt-'));
      fs.mkdirSync(path.join(otherHome, 'sessions'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(otherHome, { recursive: true, force: true });
    });

    it('reports the settings file under the new root and abandons the old one', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      fs.writeFileSync(
        path.join(otherHome, 'settings.json'),
        JSON.stringify({ model: 'claude-fable-5[1m]' }),
        'utf-8'
      );
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const afterStart = settings.count;
      watcher.updateClaudeHomePath(otherHome);
      // Mirrors start(): the new root's settings file is reported rather than silently adopted.
      await waitUntil(() => settings.count > afterStart);
      await sleep(SETTLE_MS);

      // The old root must be fully abandoned — nothing it does can reach us any more.
      const afterSwitch = settings.count;
      writeSettings('claude-sonnet-5', base + 10_000);
      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(afterSwitch);

      // ...while the new root is live.
      const otherSettings = path.join(otherHome, 'settings.json');
      fs.writeFileSync(otherSettings, JSON.stringify({ model: 'claude-opus-5' }), 'utf-8');
      fs.utimesSync(otherSettings, new Date(base + 20_000), new Date(base + 20_000));
      await waitUntil(() => settings.count > afterSwitch);
    });

    it('is a no-op when the path is unchanged', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      watcher.updateClaudeHomePath(home);

      // A re-report here would mean the baseline was reset, and every config save — of any
      // setting — would redundantly re-resolve the model.
      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(before);
    });
  });

  describe('dispose', () => {
    it('cancels a pending debounce so nothing fires afterwards', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      const before = settings.count;
      writeSettings('claude-fable-5[1m]', base + 5_000);
      // Long enough for the poll to notice and schedule, short enough to beat the debounce.
      await sleep(POLL_MS * 3);
      watcher.dispose();
      watcher = null;

      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(before);
    });

    it('silences every source it watched, and is idempotent', { timeout: 10_000 }, async () => {
      // Asserted behaviourally rather than by counting close() calls: fs.watch cannot be
      // spied on under ESM, and "no events after dispose" is the property that matters.
      const base = Date.now();
      const transcript = writeTranscript('session-a');
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      const transcripts = counterFor((l) => watcher!.onTranscriptChanged(l));
      const sessions = counterFor((l) => watcher!.onSessionsChanged(l));
      await startAndDrain(settings);
      watcher.watchTranscript(transcript);
      await sleep(ARM_MS);

      watcher.dispose();
      expect(() => watcher!.dispose()).not.toThrow();
      const before = {
        settings: settings.count,
        transcripts: transcripts.count,
        sessions: sessions.count,
      };
      watcher = null;

      writeSettings('claude-fable-5[1m]', base + 5_000);
      fs.appendFileSync(transcript, '{"type":"assistant"}\n', 'utf-8');
      fs.writeFileSync(path.join(home, 'sessions', 'a.json'), '{}', 'utf-8');

      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(before.settings);
      expect(transcripts.count).toBe(before.transcripts);
      expect(sessions.count).toBe(before.sessions);
    });

    it('stops the settings poll', async () => {
      const base = Date.now();
      writeSettings('claude-opus-5', base);
      watcher = new FileWatcher(home, 60_000, POLL_MS);
      const settings = counterFor((l) => watcher!.onModelSettingsChanged(l));
      await startAndDrain(settings);

      watcher.dispose();
      const before = settings.count;
      watcher = null;

      writeSettings('claude-fable-5[1m]', base + 5_000);
      await sleep(SETTLE_MS * 2);
      expect(settings.count).toBe(before);
    });
  });
});
