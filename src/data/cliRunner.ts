import { exec } from 'child_process';

interface CliCacheEntry {
  data: CliUsageResult;
  timestamp: number;
}

export interface CliUsageResult {
  totalCostUsd: number;
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      costUSD: number;
    }
  >;
  sessionId: string;
}

let cache: CliCacheEntry | null = null;

export async function fetchUsageFromCli(
  minIntervalMs: number = 30000
): Promise<CliUsageResult | null> {
  if (cache && Date.now() - cache.timestamp < minIntervalMs) {
    return cache.data;
  }

  try {
    const result = await runCli('claude -p "/cost" --output-format json');
    const parsed = JSON.parse(result);

    const usage: CliUsageResult = {
      totalCostUsd: parsed.total_cost_usd ?? 0,
      modelUsage: parsed.modelUsage ?? {},
      sessionId: parsed.session_id ?? '',
    };

    cache = { data: usage, timestamp: Date.now() };
    return usage;
  } catch {
    return cache?.data ?? null;
  }
}

export function clearCliCache(): void {
  cache = null;
}

function runCli(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
