import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { forEachLine } from '../src/utils/jsonlLines';

let dir: string;
let file: string;

const collect = async (
  start = 0,
  options?: { includeUnterminated?: boolean }
): Promise<{ lines: string[]; consumedUpTo: number }> => {
  const lines: string[] = [];
  const consumedUpTo = await forEachLine(file, start, (l) => lines.push(l), options);
  return { lines, consumedUpTo };
};

describe('forEachLine', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pulse-lines-'));
    file = path.join(dir, 't.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('delivers complete lines and stops the cursor before a partial one', async () => {
    fs.writeFileSync(file, 'a\nbb\n\nccc');
    const { lines, consumedUpTo } = await collect();
    expect(lines).toEqual(['a', 'bb']);
    expect(consumedUpTo).toBe(6);
  });

  it('resumes from a cursor, reading only what was appended', async () => {
    fs.writeFileSync(file, 'one\ntw');
    const first = await collect();
    fs.appendFileSync(file, 'o\nthree\n');
    const second = await collect(first.consumedUpTo);
    expect(second.lines).toEqual(['two', 'three']);
    expect(second.consumedUpTo).toBe(fs.statSync(file).size);
  });

  it('counts offsets in bytes, so multi-byte text cannot shift them', async () => {
    fs.writeFileSync(file, 'éé\n\u{1F600}\n');
    const { lines, consumedUpTo } = await collect();
    expect(lines).toEqual(['éé', '\u{1F600}']);
    expect(consumedUpTo).toBe(Buffer.byteLength('éé\n\u{1F600}\n'));
  });

  it('reassembles a line longer than one read chunk', async () => {
    const long = 'x'.repeat(700 * 1024);
    fs.writeFileSync(file, `${long}\nshort\n`);
    const { lines } = await collect();
    expect(lines.map((l) => l.length)).toEqual([long.length, 5]);
  });

  it('delivers the unterminated last line only when asked, without consuming it', async () => {
    fs.writeFileSync(file, 'a\nlast');
    const { lines, consumedUpTo } = await collect(0, { includeUnterminated: true });
    expect(lines).toEqual(['a', 'last']);
    expect(consumedUpTo).toBe(2);
  });

  it('rejects when the file is missing', async () => {
    await expect(collect()).rejects.toThrow();
  });
});
