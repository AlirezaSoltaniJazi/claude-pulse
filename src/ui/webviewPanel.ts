import * as vscode from 'vscode';
import { ClaudePulseData } from '../types';
import { generateDashboardHtml } from './webviewContent';

export class DashboardPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly _onResetTimer = new vscode.EventEmitter<void>();
  readonly onResetTimer = this._onResetTimer.event;

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
        }
      });
    }

    this.panel.webview.html = generateDashboardHtml(data, resetIntervalMinutes);
  }

  update(data: ClaudePulseData, resetIntervalMinutes: number): void {
    if (this.panel) {
      this.panel.webview.html = generateDashboardHtml(data, resetIntervalMinutes);
    }
  }

  get isVisible(): boolean {
    return this.panel !== null;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
    this._onResetTimer.dispose();
  }
}
