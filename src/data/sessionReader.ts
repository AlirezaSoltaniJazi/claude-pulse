import * as fs from 'fs';
import * as path from 'path';
import { SessionFile } from '../types';

export async function readSessions(claudeHomePath: string): Promise<SessionFile[]> {
  const sessionsDir = path.join(claudeHomePath, 'sessions');

  try {
    const files = await fs.promises.readdir(sessionsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const sessions: SessionFile[] = [];
    for (const file of jsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(sessionsDir, file), 'utf-8');
        const session = JSON.parse(content) as SessionFile;
        if (session.pid && session.sessionId) {
          sessions.push(session);
        }
      } catch {
        // Skip malformed session files
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getActiveSessions(sessions: SessionFile[]): SessionFile[] {
  return sessions.filter((s) => isProcessAlive(s.pid));
}

export function getMostRecentSession(sessions: SessionFile[]): SessionFile | null {
  if (sessions.length === 0) return null;
  return sessions.reduce((latest, s) => (s.startedAt > latest.startedAt ? s : latest));
}
