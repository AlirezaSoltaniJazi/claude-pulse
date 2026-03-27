import * as fs from 'fs';
import * as path from 'path';
import { ClaudeUsage, StatsCache } from '../types';

export async function readStats(claudeHomePath: string): Promise<StatsCache | null> {
  const statsPath = path.join(claudeHomePath, 'stats-cache.json');

  try {
    const content = await fs.promises.readFile(statsPath, 'utf-8');
    const data = JSON.parse(content);

    // Support both old format (version + dailyActivity) and new format
    if (data.version && data.dailyActivity) {
      return data as StatsCache;
    }

    return null;
  } catch {
    return null;
  }
}

export async function readUsageFromCache(claudeHomePath: string): Promise<ClaudeUsage | null> {
  const statsPath = path.join(claudeHomePath, 'stats-cache.json');

  try {
    const content = await fs.promises.readFile(statsPath, 'utf-8');
    const data = JSON.parse(content);

    if (data.usage) {
      return data.usage as ClaudeUsage;
    }

    return null;
  } catch {
    return null;
  }
}
