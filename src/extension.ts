import * as vscode from 'vscode';
import { DashboardPanel } from './webview/dashboard';
import { UsageSnapshot } from './usage';
import { UsageManager } from './usageManager';

let refreshTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new UsageManager(context.globalState.get<UsageSnapshot>('tokenbar.lastSnapshot'));
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'tokenbar.openDashboard';
  statusBar.text = '$(pulse) TokenBar…';
  statusBar.tooltip = 'Consultando as cotas das assinaturas';
  statusBar.show();

  const updateStatusBar = () => {
    const snapshot = manager.getSnapshot();
    const providers = snapshot.providers.filter(provider => provider.status === 'ok' && provider.windows.length);
    if (!providers.length) {
      statusBar.text = '$(warning) TokenBar';
      statusBar.tooltip = 'Nenhuma cota disponível. Clique para ver o diagnóstico.';
      return;
    }
    const mostUrgent = providers
      .flatMap(provider => provider.windows.map(window => ({ provider: provider.label, used: window.usedPercent })))
      .sort((a, b) => b.used - a.used)[0];
    statusBar.text = `$(pulse) ${mostUrgent.provider} ${mostUrgent.used.toFixed(0)}%`;
    statusBar.tooltip = new vscode.MarkdownString(providers.map(provider => {
      const lines = provider.windows.map(window => `- ${window.label}: **${window.usedPercent.toFixed(0)}% usado**`);
      return `### ${provider.label}\n${lines.join('\n')}`;
    }).join('\n\n'));
  };

  // Nunca propaga: falhar aqui abortaria a ativação da extensão, e no agendamento viraria
  // uma promise rejeitada sem dono. Os coletores já traduzem erro em snapshot; o catch é
  // para o que escapar disso.
  const refresh = async (showProgress = false) => {
    statusBar.text = '$(sync~spin) TokenBar';
    try {
      if (showProgress) {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Atualizando cotas das assinaturas…' }, () => manager.refresh({ force: true }));
      } else {
        await manager.refresh({ force: false });
      }
    } catch (error) {
      console.error('TokenBar: falha ao atualizar as cotas.', error);
    }
    updateStatusBar();
  };

  context.subscriptions.push(
    statusBar,
    manager.onDidUpdate(snapshot => {
      void context.globalState.update('tokenbar.lastSnapshot', snapshot);
      updateStatusBar();
    }),
    vscode.commands.registerCommand('tokenbar.openDashboard', async () => {
      DashboardPanel.createOrShow(context.extensionUri, manager, () => refresh(true));
      if (!manager.getSnapshot().providers.length) {
        await refresh();
      }
    }),
    vscode.commands.registerCommand('tokenbar.refresh', () => refresh(true)),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('tokenbar.refreshInterval')) {
        scheduleRefresh(refresh);
      }
    })
  );

  scheduleRefresh(refresh);
  await refresh();
}

function scheduleRefresh(refresh: () => Promise<void>): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const seconds = vscode.workspace.getConfiguration('tokenbar').get<number>('refreshInterval', 60);
  refreshTimer = setInterval(() => void refresh(), Math.max(15, seconds) * 1000);
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}
