import * as fs from 'fs';
import * as path from 'path';
import { WeeklyUsageSummary } from '../types';

interface ScanCache {
  data: WeeklyUsageSummary;
  timestamp: number;
}

let scanCache: ScanCache | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Scans JSONL session files to compute accurate weekly usage stats.
 * Only scans files modified since the start of the current week.
 */
export async function scanWeeklyUsage(
  claudeHomePath: string,
  forceRefresh: boolean = false
): Promise<WeeklyUsageSummary | null> {
  if (!forceRefresh && scanCache && Date.now() - scanCache.timestamp < CACHE_TTL_MS) {
    return scanCache.data;
  }

  try {
    const { weekStart, weekEnd, weekStartDate } = getCurrentWeekBounds();
    const projectsDir = path.join(claudeHomePath, 'projects');

    if (!fs.existsSync(projectsDir)) {
      return null;
    }

    // Find all project directories
    const projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });

    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalTokens = 0;
    let sonnetTokens = 0;
    const tokensByModel: Record<string, number> = {};
    const sessionIds = new Set<string>();

    const weekStartMs = weekStartDate.getTime();

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;

      const dirPath = path.join(projectsDir, dir.name);
      let files: fs.Dirent[];
      try {
        files = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const jsonlFiles = files.filter(f => f.name.endsWith('.jsonl'));

      for (const file of jsonlFiles) {
        const filePath = path.join(dirPath, file.name);

        // Quick check: skip files not modified since week start
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs < weekStartMs) continue;
        } catch {
          continue;
        }

        const sessionId = file.name.replace('.jsonl', '');
        try {
          const result = await scanSingleFile(filePath, weekStartDate);
          if (result.messageCount > 0) {
            sessionIds.add(sessionId);
            totalMessages += result.messageCount;
            totalToolCalls += result.toolCallCount;

            for (const [model, tokens] of Object.entries(result.tokensByModel)) {
              tokensByModel[model] = (tokensByModel[model] ?? 0) + tokens;
              totalTokens += tokens;
              if (model.toLowerCase().includes('sonnet')) {
                sonnetTokens += tokens;
              }
            }
          }
        } catch {
          // Skip problematic files
        }
      }
    }

    const data: WeeklyUsageSummary = {
      weekStart,
      weekEnd,
      totalMessages,
      totalSessions: sessionIds.size,
      totalToolCalls,
      tokensByModel,
      totalTokens,
      sonnetTokens,
    };

    scanCache = { data, timestamp: Date.now() };
    return data;
  } catch {
    return scanCache?.data ?? null;
  }
}

export function clearScanCache(): void {
  scanCache = null;
}

interface FileScanResult {
  messageCount: number;
  toolCallCount: number;
  tokensByModel: Record<string, number>;
}

async function scanSingleFile(
  filePath: string,
  weekStartDate: Date
): Promise<FileScanResult> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.split('\n');

  let messageCount = 0;
  let toolCallCount = 0;
  const tokensByModel: Record<string, number> = {};

  for (const line of lines) {
    if (!line) continue;

    try {
      const event = JSON.parse(line);

      // Check timestamp is within current week
      if (event.timestamp) {
        const eventDate = new Date(event.timestamp);
        if (eventDate < weekStartDate) continue;
      }

      if (event.type === 'assistant' && event.message) {
        const msg = event.message;
        messageCount++;

        const model = msg.model ?? 'unknown';
        const usage = msg.usage;
        if (usage) {
          const tokens =
            (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0);
          tokensByModel[model] = (tokensByModel[model] ?? 0) + tokens;
        }

        // Count tool uses in content
        if (msg.content && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'tool_use') {
              toolCallCount++;
            }
          }
        }
      }

      if (event.type === 'user') {
        messageCount++;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { messageCount, toolCallCount, tokensByModel };
}

function getCurrentWeekBounds(): {
  weekStart: string;
  weekEnd: string;
  weekStartDate: Date;
} {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    weekStart: formatDate(monday),
    weekEnd: formatDate(sunday),
    weekStartDate: monday,
  };
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}
