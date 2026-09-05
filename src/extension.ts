import * as vscode from 'vscode';
import { DashboardPanel } from './webview/dashboard';
import { formatAge, isProviderOutdated, isWindowExpired, providerNeedsAttention, UsageSnapshot, worstCurrentUsage } from './usage';
import { createDiagnosticLogger } from './diagnostics';
import { UsageManager } from './usageManager';

let refreshTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new UsageManager(context.globalState.get<UsageSnapshot>('tokenbar.lastSnapshot'), {
    onDiagnostic: createDiagnosticLogger(context.globalStorageUri.fsPath)
  });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'tokenbar.openDashboard';
  statusBar.text = '$(pulse) TokenBar…';
  statusBar.tooltip = 'Consultando as cotas das assinaturas';
  statusBar.show();

  const updateStatusBar = () => {
    const snapshot = manager.getSnapshot();
    const worst = worstCurrentUsage(snapshot);
    const attention = snapshot.providers.some(provider => providerNeedsAttention(provider));
    statusBar.text = worst ? `${attention ? '$(warning)' : '$(pulse)'} ${worst.provider.label} ${worst.window.usedPercent.toFixed(0)}%` : '$(warning) TokenBar';
    // Texto simples: rótulos e diagnósticos externos não são interpretados como Markdown.
    statusBar.tooltip = snapshot.providers.map(provider => {
      const lines = provider.windows.map(window => `${window.label}: ${window.usedPercent.toFixed(0)}%${isProviderOutdated(provider) || isWindowExpired(window) ? ' (último dado)' : ' usado'}`);
      const collected = provider.windows.length ? `Última coleta ${formatAge(provider.collectedAt)}` : 'Sem coleta válida';
      const retry = provider.nextRetryAt ? `Próxima tentativa: ${new Date(provider.nextRetryAt).toLocaleTimeString('pt-BR')}` : '';
      return [provider.label, provider.message, collected, ...lines, retry].filter(Boolean).join('\n');
    }).join('\n\n') || 'Nenhuma cota disponível. Clique para ver o diagnóstico.';
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

  const ageTimer = setInterval(updateStatusBar, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(ageTimer) });

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
