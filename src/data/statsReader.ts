import * as fs from 'fs';
import * as path from 'path';
import { StatsCache } from '../types';

export async function readStats(claudeHomePath: string): Promise<StatsCache | null> {
  const statsPath = path.join(claudeHomePath, 'stats-cache.json');

  try {
    const content = await fs.promises.readFile(statsPath, 'utf-8');
    const data = JSON.parse(content) as StatsCache;

    if (!data.version || !data.dailyActivity) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}
