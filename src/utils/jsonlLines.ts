import * as fs from 'fs';

/**
 * Calls `onLine` for every complete line of `filePath` from byte `start` onwards, streaming.
 *
 * Exists because transcripts are large — 97 MB for a single session on a working machine —
 * and `readFile` + `split('\n')` holds the whole file as one string AND again as an array of
 * lines. Across a week of transcripts that pushed the extension host from ~50 MB to ~650 MB
 * on every weekly scan. Streaming keeps only one chunk and one line alive at a time.
 *
 * Returns the byte offset just past the last newline seen, so a caller can resume from there
 * next time and read only what was appended. A trailing partial line — a record still being
 * written — is never delivered and never counted as consumed, so the resumed read gets it
 * whole. Offsets are counted on bytes, not decoded characters, so multi-byte text cannot shift
 * them. Lines are delivered without their newline; empty lines are skipped.
 *
 * `includeUnterminated` also delivers that trailing line, for one-shot whole-file reads that
 * will not resume: a complete record that merely lacks its newline still counts there. The
 * returned offset still stops before it, so the two modes never double-count when mixed.
 *
 * Rejects only if the file cannot be opened; `onLine` exceptions propagate.
 */
export function forEachLine(
  filePath: string,
  start: number,
  onLine: (line: string) => void,
  options: { includeUnterminated?: boolean } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start, highWaterMark: 256 * 1024 });
    let pending: Buffer | null = null;
    let consumedUpTo = start;

    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const data: Buffer = pending ? Buffer.concat([pending, buf]) : buf;

      let lineStart = 0;
      let newline = data.indexOf(0x0a, lineStart);
      try {
        while (newline !== -1) {
          if (newline > lineStart) onLine(data.toString('utf-8', lineStart, newline));
          lineStart = newline + 1;
          newline = data.indexOf(0x0a, lineStart);
        }
      } catch (e) {
        stream.destroy();
        reject(e);
        return;
      }

      consumedUpTo += lineStart;
      // Copied, not sliced: a slice would pin the whole chunk in memory until the next one.
      pending = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : null;
    });

    stream.on('error', reject);
    stream.on('end', () => {
      if (options.includeUnterminated && pending && pending.length > 0) {
        try {
          onLine(pending.toString('utf-8'));
        } catch (e) {
          reject(e);
          return;
        }
      }
      resolve(consumedUpTo);
    });
  });
}
