import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { UsageSnapshot } from '../usage';
import { UsageManager } from '../usageManager';

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
    this.panel.webview.html = this.getHtml(manager.getSnapshot());
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(async message => {
      if (message.command === 'refresh') {
        await this.refresh(false);
      }
    }, null, this.disposables);
    this.disposables.push(manager.onDidUpdate(() => this.update()) as vscode.Disposable);
  }

  private update(): void {
    this.panel.webview.html = this.getHtml(this.manager.getSnapshot());
  }

  private dispose(): void {
    DashboardPanel.currentPanel = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }

  private getHtml(snapshot: UsageSnapshot): string {
    const cards = snapshot.providers.map(provider => {
      const windows = provider.windows.map(window => {
        const remaining = Math.max(0, 100 - window.usedPercent);
        const tone = remaining <= 10 ? 'danger' : remaining <= 30 ? 'warning' : 'healthy';
        return `<article class="window">
          <div class="window-head"><span>${escapeHtml(window.label)}</span><strong class="${tone}">${remaining.toFixed(0)}% restante</strong></div>
          <div class="track"><div class="fill ${tone}" style="width:${remaining}%"></div></div>
          <div class="meta"><span>${window.usedPercent.toFixed(0)}% usado</span><span>${formatReset(window.resetsAt)}</span></div>
          ${window.detail ? `<div class="detail">${escapeHtml(window.detail)}</div>` : ''}
        </article>`;
      }).join('');
      const state = provider.stale
        ? '<span class="badge stale">último dado</span>'
        : provider.status === 'ok' ? '<span class="badge ok">ao vivo</span>' : `<span class="badge ${provider.status}">${provider.status === 'error' ? 'erro' : 'indisponível'}</span>`;
      return `<section class="provider ${provider.provider}">
        <header><div><div class="eyebrow">${escapeHtml(provider.source)}</div><h2>${escapeHtml(provider.label)}</h2></div>${state}</header>
        ${provider.plan ? `<div class="plan">Plano ${escapeHtml(provider.plan)}</div>` : ''}
        <div class="windows">${windows || `<div class="empty">${escapeHtml(provider.message ?? 'Nenhuma janela retornada.')}</div>`}</div>
        ${provider.message && windows ? `<div class="notice">${escapeHtml(provider.message)}</div>` : ''}
      </section>`;
    }).join('');

    const nonce = createNonce();

    return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>TokenBar</title><style>
:root{color-scheme:dark;--bg:#090b10;--panel:#11151d;--border:#232a36;--muted:#8c97a8;--text:#eef2f7;--green:#5de1a2;--amber:#ffbd66;--red:#ff6b78}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#18233b 0,transparent 32%),var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1180px;margin:auto;padding:32px 24px 60px}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:26px}.brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#79a9ff}.top h1{font-size:32px;line-height:1.1;margin:6px 0}.subtitle{color:var(--muted);max-width:680px}.refresh{border:1px solid #36517d;background:#15233a;color:#dce9ff;border-radius:10px;padding:10px 16px;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.provider{position:relative;background:linear-gradient(180deg,rgba(255,255,255,.025),transparent),var(--panel);border:1px solid var(--border);border-radius:18px;padding:20px;min-height:260px;overflow:hidden}.provider:before{content:"";position:absolute;inset:0 0 auto;height:3px;background:#888}.provider.claude:before{background:#d98b5f}.provider.codex:before{background:#65d6b1}header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.eyebrow{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em}h2{font-size:23px;margin:2px 0 0}.badge{font-size:10px;text-transform:uppercase;letter-spacing:.08em;border-radius:999px;padding:4px 8px;background:#222}.badge.ok{color:var(--green);background:#123026}.badge.stale{color:var(--amber);background:#342817}.badge.error{color:var(--red);background:#341920}.badge.unavailable{color:var(--amber);background:#342817}.plan{color:var(--muted);margin-top:4px}.windows{display:flex;flex-direction:column;gap:15px;margin-top:22px}.window{padding-top:14px;border-top:1px solid var(--border)}.window-head,.meta{display:flex;justify-content:space-between;gap:10px}.window-head strong{font-size:12px}.track{height:7px;background:#242a35;border-radius:99px;margin:10px 0;overflow:hidden}.fill{height:100%;border-radius:99px}.healthy{color:var(--green)}.fill.healthy{background:var(--green)}.warning{color:var(--amber)}.fill.warning{background:var(--amber)}.danger{color:var(--red)}.fill.danger{background:var(--red)}.meta,.detail{font-size:11px;color:var(--muted)}.detail{margin-top:4px}.empty{color:var(--muted);padding:22px 0}.notice{margin-top:14px;padding:9px 11px;border:1px solid #5a4827;border-radius:8px;background:#2d2517;color:var(--amber);font-size:11px}.footer{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:20px}@media(max-width:900px){.grid{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}
@media(min-width:901px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main class="shell"><div class="top"><div><div class="brand">TokenBar</div><h1>Cotas das suas assinaturas</h1><div class="subtitle">Percentuais reais informados pelos serviços. “Restante” é a cota da assinatura, não o espaço de contexto da conversa.</div></div><button class="refresh">↻ Atualizar agora</button></div><div class="grid">${cards}</div><div class="footer"><span>Atualização automática configurável</span><span>Coletado ${formatCollected(snapshot.collectedAt)}</span></div></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelector('.refresh').addEventListener('click',()=>vscode.postMessage({command:'refresh'}))</script></body></html>`;
  }
}

function createNonce(): string {
  return randomBytes(16).toString('base64');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]!));
}

function formatReset(value?: string): string {
  if (!value) {
    return 'renovação não informada';
  }
  const date = new Date(value);
  return `renova ${date.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

function formatCollected(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'agora';
}
