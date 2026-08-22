import * as vscode from 'vscode';
import { UsageSnapshot } from '../usage';
import { UsageManager } from '../usageManager';
import { renderDashboard } from './render';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly manager: UsageManager;
  private readonly refresh: (showProgress?: boolean) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri, manager: UsageManager, refresh: (showProgress?: boolean) => Promise<void>): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal();
      DashboardPanel.currentPanel.update();
      return;
    }
    const panel = vscode.window.createWebviewPanel('tokenbarDashboard', 'TokenBar · Cotas', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri]
    });
    DashboardPanel.currentPanel = new DashboardPanel(panel, manager, refresh);
  }

  private constructor(panel: vscode.WebviewPanel, manager: UsageManager, refresh: (showProgress?: boolean) => Promise<void>) {
    this.panel = panel;
    this.manager = manager;
    this.refresh = refresh;
    this.panel.webview.html = renderDashboard(manager.getSnapshot());
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(async message => {
      if (message.command === 'refresh') {
        await this.refresh(false);
      }
    }, null, this.disposables);
    this.disposables.push(manager.onDidUpdate(() => this.update()) as vscode.Disposable);
  }

  private update(): void {
    this.panel.webview.html = renderDashboard(this.manager.getSnapshot());
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
