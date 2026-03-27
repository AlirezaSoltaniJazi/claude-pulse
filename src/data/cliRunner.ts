import { exec } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CliSessionData, RateLimitInfo, ModelUsage } from '../types';

interface CliCacheEntry {
  data: CliSessionData;
  timestamp: number;
}

let cache: CliCacheEntry | null = null;

function findClaudePath(): string {
  // Common locations for claude binary
  const candidates = [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.npm-global/bin/claude'),
    path.join(os.homedir(), '.local/bin/claude'),
    'claude', // fallback to PATH
  ];

  return candidates[0]; // Default to homebrew on macOS
}

export async function fetchCliSessionData(
  minIntervalMs: number = 30000
): Promise<CliSessionData | null> {
  if (cache && Date.now() - cache.timestamp < minIntervalMs) {
    return cache.data;
  }

  try {
    const claudePath = findClaudePath();
    const rawOutput = await runCli(
      `${claudePath} -p "." --output-format stream-json --verbose`
    );

    const lines = rawOutput.trim().split('\n');
    let rateLimitInfo: RateLimitInfo | null = null;
    let totalCostUsd = 0;
    let modelUsage: Record<string, ModelUsage> = {};
    let sessionId = '';

    for (const line of lines) {
      try {
        const event = JSON.parse(line);

        if (event.type === 'rate_limit_event' && event.rate_limit_info) {
          rateLimitInfo = {
            status: event.rate_limit_info.status ?? 'unknown',
            resetsAt: event.rate_limit_info.resetsAt ?? 0,
            rateLimitType: event.rate_limit_info.rateLimitType ?? '',
            overageStatus: event.rate_limit_info.overageStatus ?? '',
            overageResetsAt: event.rate_limit_info.overageResetsAt ?? 0,
            isUsingOverage: event.rate_limit_info.isUsingOverage ?? false,
          };
        }

        if (event.type === 'result') {
          totalCostUsd = event.total_cost_usd ?? 0;
          modelUsage = event.modelUsage ?? {};
          sessionId = event.session_id ?? '';
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    const data: CliSessionData = {
      rateLimitInfo,
      totalCostUsd,
      modelUsage,
      sessionId,
    };

    cache = { data, timestamp: Date.now() };
    return data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(`Claude Pulse: Failed to fetch CLI data - ${msg}`);
    return cache?.data ?? null;
  }
}

export function clearCliCache(): void {
  cache = null;
}

function runCli(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use login shell to inherit PATH
    const shell = process.env.SHELL || '/bin/zsh';
    exec(command, {
      timeout: 60000,
      shell: shell,
      env: {
        ...process.env,
        PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin:${path.join(os.homedir(), '.local/bin')}`,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}
