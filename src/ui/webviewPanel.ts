import * as vscode from 'vscode';
import { ClaudePulseData } from '../types';
import { DashboardViewState, generateDashboardHtml } from './webviewContent';

/**
 * A termination request from the graph view.
 *
 * `agentDescription` is set only when the user aimed at a subagent. The target process is
 * the session either way — subagents share its PID — and naming the agent is what lets the
 * confirmation say which one the click was for.
 */
export interface KillRequest {
  pid: number;
  sessionId: string;
  /** The session's display label, for the confirmation text. */
  label: string;
  agentDescription?: string;
}

export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly _onResetTimer = new vscode.EventEmitter<void>();
  readonly onResetTimer = this._onResetTimer.event;
  private readonly _onRefreshData = new vscode.EventEmitter<void>();
  readonly onRefreshData = this._onRefreshData.event;
  private readonly _onKillRequested = new vscode.EventEmitter<KillRequest>();
  readonly onKillRequested = this._onKillRequested.event;

  /**
   * Which agent tab is open. Panel state, not extension state, and deliberately not fired
   * as an event: the webview has already switched tabs by the time this arrives, so nothing
   * needs to re-render. It only has to be remembered for the next poll-driven rewrite, which
   * would otherwise snap the user back to the first tab every few seconds.
   */
  private viewState: DashboardViewState = { activeAgentTab: null, expandedSessions: [] };

  show(data: ClaudePulseData, resetIntervalMinutes: number): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'claudePulseDashboard',
        'Claude Pulse',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = null;
      });

      this.panel.webview.onDidReceiveMessage((message) => {
        if (message.command === 'resetTimer') {
          this._onResetTimer.fire();
        } else if (message.command === 'refreshData') {
          this._onRefreshData.fire();
        } else if (message.command === 'setSessionExpanded') {
          this.viewState = {
            ...this.viewState,
            expandedSessions: applyExpansion(this.viewState.expandedSessions, message),
          };
        } else if (message.command === 'selectAgentTab') {
          this.viewState = {
            ...this.viewState,
            activeAgentTab: typeof message.key === 'string' && message.key ? message.key : null,
          };
        } else if (message.command === 'killSession' || message.command === 'killAgent') {
          const request = parseKillRequest(message);
          // A malformed request is dropped here rather than forwarded: the handler would
          // refuse it anyway, and a toast about a PID the user never saw is just noise.
          if (request) this._onKillRequested.fire(request);
        }
      });
    }

    this.render(data, resetIntervalMinutes);
  }

  update(data: ClaudePulseData, resetIntervalMinutes: number): void {
    if (this.panel) this.render(data, resetIntervalMinutes);
  }

  /**
   * Draws the panel, dropping remembered expansions for sessions that are no longer in the
   * graph.
   *
   * Sessions end, and the graph only ever shows the newest AGENT_GRAPH_MAX_SESSIONS of them,
   * so without this the list would grow for as long as the window stays open and keep ids
   * nothing can render. Pruning at render time is also what makes a re-opened session id
   * come back folded rather than inheriting a stale open state.
   */
  private render(data: ClaudePulseData, resetIntervalMinutes: number): void {
    if (!this.panel) return;

    const known = new Set(data.agentGraph?.sessions.map((session) => session.sessionId) ?? []);
    const pruned = this.viewState.expandedSessions.filter((id) => known.has(id));
    if (pruned.length !== this.viewState.expandedSessions.length) {
      this.viewState = { ...this.viewState, expandedSessions: pruned };
    }

    this.panel.webview.html = generateDashboardHtml(data, resetIntervalMinutes, this.viewState);
  }

  get isVisible(): boolean {
    return this.panel !== null;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this._onResetTimer.dispose();
    this._onRefreshData.dispose();
    this._onKillRequested.dispose();
  }
}

/**
 * Folds a setSessionExpanded message into the remembered list.
 *
 * Every id is shape-checked for the same reason the kill payload is: the message comes from
 * a page whose DOM is built from model-authored text. An id that names no session is
 * harmless anyway — the next render prunes it — but it never gets to be unbounded either,
 * because only ids the graph put in the DOM can survive that prune.
 */
function applyExpansion(current: string[], message: unknown): string[] {
  if (typeof message !== 'object' || message === null) return current;
  const raw = message as Record<string, unknown>;

  const ids = Array.isArray(raw.sessionIds)
    ? raw.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (ids.length === 0) return current;

  if (raw.expanded === true) return [...new Set([...current, ...ids])];

  const removed = new Set(ids);
  return current.filter((id) => !removed.has(id));
}

/**
 * Narrows a webview message into a KillRequest, or null.
 *
 * Webview messages are structured-cloned from a page whose own DOM is built from
 * model-authored text, so every field is checked rather than trusted. The PID is only
 * *shape*-checked here; that it names a real Claude session is settled by
 * resolveKillTarget(), which is the one place that decision belongs.
 */
function parseKillRequest(message: unknown): KillRequest | null {
  if (typeof message !== 'object' || message === null) return null;
  const raw = message as Record<string, unknown>;

  const pid = raw.pid;
  const sessionId = raw.sessionId;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

  return {
    pid,
    sessionId,
    label: typeof raw.label === 'string' && raw.label ? raw.label : sessionId.slice(0, 8),
    agentDescription:
      typeof raw.agentDescription === 'string' && raw.agentDescription
        ? raw.agentDescription
        : undefined,
  };
}
