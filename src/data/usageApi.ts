import { exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as vscode from 'vscode';
import { ClaudeUsage } from '../types';
import {
  MAX_RETRIES,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_429_MS,
  USAGE_CACHE_TTL_MS,
  USAGE_API_HOSTNAME,
  USAGE_API_PATH,
  API_TIMEOUT_MS,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TIMEOUT_MS,
} from '../constants';

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string; // TODO: implement token refresh using refreshToken when accessToken expires
  expiresAt: string;
}

interface UsageCache {
  data: ClaudeUsage;
  timestamp: number;
}

interface ApiResult {
  status: number;
  data: ClaudeUsage | null;
  retryAfterMs?: number;
}

let cache: UsageCache | null = null;
let outputChannel: vscode.OutputChannel | null = null;

function log(msg: string): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('Claude Pulse');
  }
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

export interface FetchUsageResult {
  data: ClaudeUsage | null;
  status: 'success' | 'cached' | 'rate_limited' | 'auth_error' | 'error' | 'no_credentials';
  message: string;
}

export async function fetchUsage(forceRefresh: boolean = false): Promise<FetchUsageResult> {
  if (!forceRefresh && cache && Date.now() - cache.timestamp < USAGE_CACHE_TTL_MS) {
    return { data: cache.data, status: 'cached', message: 'Using cached data' };
  }

  try {
    log('Fetching OAuth credentials...');
    const credentials = await getOAuthCredentials();
    if (!credentials) {
      log('No OAuth credentials found');
      return {
        data: cache?.data ?? null,
        status: 'no_credentials',
        message: 'Could not read OAuth credentials from keychain',
      };
    }

    log('Calling usage API...');
    const result = await callUsageApi(credentials.accessToken);
    if (result.data) {
      log(
        `Usage API success: 5h=${result.data.five_hour?.utilization}%, 7d=${result.data.seven_day?.utilization}%, extra=${JSON.stringify(result.data.extra_usage)}`
      );
      cache = { data: result.data, timestamp: Date.now() };
      return { data: result.data, status: 'success', message: 'Usage data refreshed from API' };
    }

    // Determine failure reason from last status
    log(`Usage API failed: lastStatus=${result.lastStatus}`);
    if (result.lastStatus === 429) {
      return {
        data: cache?.data ?? null,
        status: 'rate_limited',
        message: 'API rate limited — using cached data. Will retry automatically.',
      };
    }
    if (result.lastStatus === 401) {
      return {
        data: cache?.data ?? null,
        status: 'auth_error',
        message: 'OAuth token expired or invalid (401)',
      };
    }
    return {
      data: cache?.data ?? null,
      status: 'error',
      message: `API returned status ${result.lastStatus}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Usage API error: ${msg}`);
    return {
      data: cache?.data ?? null,
      status: 'error',
      message: `API error: ${msg}`,
    };
  }
}

export function clearUsageCache(): void {
  cache = null;
}

async function getOAuthCredentials(): Promise<OAuthCredentials | null> {
  if (process.platform === 'darwin') {
    return getCredentialsFromKeychain();
  }
  return getCredentialsFromFile();
}

async function getCredentialsFromKeychain(): Promise<OAuthCredentials | null> {
  const securityBin = '/usr/bin/security';

  return new Promise((resolve) => {
    exec(
      `${securityBin} find-generic-password -s "${KEYCHAIN_SERVICE}"`,
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }

        const acctMatch = stdout.match(/"acct"<blob>="([^"]+)"/);
        const account = acctMatch ? acctMatch[1] : os.userInfo().username;

        exec(
          `${securityBin} find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" -w`,
          { timeout: KEYCHAIN_TIMEOUT_MS },
          (err2, stdout2) => {
            if (err2) {
              resolve(null);
              return;
            }

            try {
              const parsed = JSON.parse(stdout2.trim());
              const oauth = parsed.claudeAiOauth;
              if (oauth?.accessToken) {
                resolve({
                  accessToken: oauth.accessToken,
                  refreshToken: oauth.refreshToken ?? '',
                  expiresAt: oauth.expiresAt ?? '',
                });
              } else {
                resolve(null);
              }
            } catch (e) {
              log(
                `Failed to parse keychain credentials: ${e instanceof Error ? e.message : String(e)}`
              );
              resolve(null);
            }
          }
        );
      }
    );
  });
}

async function getCredentialsFromFile(): Promise<OAuthCredentials | null> {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await fs.promises.readFile(credPath, 'utf-8');
    const parsed = JSON.parse(content);
    const oauth = parsed.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken ?? '',
        expiresAt: oauth.expiresAt ?? '',
      };
    }
  } catch (e) {
    log(`Failed to read credentials file: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

interface CallResult {
  data: ClaudeUsage | null;
  lastStatus: number;
}

async function callUsageApi(accessToken: string): Promise<CallResult> {
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    log(`API attempt ${attempt + 1}/${MAX_RETRIES}...`);
    const result = await callUsageApiOnce(accessToken);
    lastStatus = result.status;
    log(
      `API response: status=${result.status}, hasData=${!!result.data}, retryAfter=${result.retryAfterMs ?? 'none'}`
    );

    if (result.status === 200 && result.data) {
      return { data: result.data, lastStatus };
    }

    // Auth error — no point retrying
    if (result.status === 401) {
      return { data: null, lastStatus };
    }

    // Rate limited — respect retry-after, with a minimum backoff
    if (result.status === 429) {
      const retryAfter =
        result.retryAfterMs && result.retryAfterMs > 0
          ? result.retryAfterMs
          : Math.min(Math.pow(2, attempt) * 2000 + MIN_BACKOFF_429_MS, MAX_BACKOFF_MS);
      log(`Rate limited, waiting ${retryAfter}ms...`);
      await sleep(retryAfter);
      continue;
    }

    // Other errors — retry with exponential backoff
    if (attempt < MAX_RETRIES - 1) {
      const delay = Math.min(Math.pow(2, attempt) * 1000, MAX_BACKOFF_MS);
      log(`Error, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  return { data: null, lastStatus };
}

function callUsageApiOnce(accessToken: string): Promise<ApiResult> {
  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: USAGE_API_HOSTNAME,
      path: USAGE_API_PATH,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
      },
      timeout: API_TIMEOUT_MS,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        let retryAfterMs: number | undefined;

        if (res.headers['retry-after']) {
          const seconds = parseInt(res.headers['retry-after'] as string, 10);
          if (!isNaN(seconds)) {
            retryAfterMs = seconds * 1000;
          }
        }

        try {
          if (status === 200) {
            resolve({ status, data: JSON.parse(body) as ClaudeUsage });
          } else {
            resolve({ status, data: null, retryAfterMs });
          }
        } catch (e) {
          log(`Failed to parse API response: ${e instanceof Error ? e.message : String(e)}`);
          resolve({ status: 0, data: null });
        }
      });
    });

    req.on('error', (e) => {
      log(`HTTP request error: ${e.message}`);
      resolve({ status: 0, data: null });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, data: null });
    });
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
