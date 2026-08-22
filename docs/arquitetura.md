# Arquitetura

## Visão geral

O TokenBar tem **um coletor** e **dois consumidores**. Todo o código de rede/IPC vive em
`src/collectors/`; a extensão do VS Code e o daemon da bandeja apenas embrulham o mesmo
`UsageManager`.

```
                    ┌──────────────────────┐
                    │   UsageManager       │  dedupe de refresh + fan-out de eventos
                    └──────────┬───────────┘
                    ┌──────────┴───────────┐
          ┌─────────▼────────┐   ┌─────────▼────────┐
          │ ClaudeCollector  │   │ CodexCollector   │
          │ HTTPS + OAuth    │   │ processo filho   │
          └─────────┬────────┘   └─────────┬────────┘
        api.anthropic.com          codex app-server --stdio

   consumidores do UsageManager:

   ┌────────────────────────┐          ┌──────────────────────────┐
   │ extension.ts           │          │ daemon.ts                │
   │ status bar + webview   │          │ escreve snapshot.json    │
   └────────────────────────┘          └────────────┬─────────────┘
                                                    │ arquivo
                                       ┌────────────▼─────────────┐
                                       │ tray/tokenbar.ps1        │
                                       │ ícone + painel (só lê)   │
                                       └──────────────────────────┘
```

## Módulos

| Arquivo | Responsabilidade |
| --- | --- |
| `src/usage.ts` | Tipos do domínio (`UsageWindow`, `ProviderSnapshot`, `UsageSnapshot`), o contrato `UsageCollector` e dois helpers: `unavailable()` e `clampPercent()`. |
| `src/usageManager.ts` | Orquestra os coletores. Deduplica refreshes concorrentes, guarda o último snapshot e notifica listeners. |
| `src/collectors/claude.ts` | Lê a sessão OAuth do Claude Code e consulta as janelas de cota. Cache, backoff e tradução de erros. |
| `src/collectors/codex.ts` | Sobe o `codex app-server` e faz o handshake para ler os limites da conta. |
| `src/extension.ts` | Ponto de entrada do VS Code: barra de status, comandos, agendamento e persistência em `globalState`. |
| `src/webview/render.ts` | Gera o HTML do painel a partir de um `UsageSnapshot`. **Puro**: não importa `vscode`, o que permite renderizá-lo fora do editor. |
| `src/webview/dashboard.ts` | Cria e gerencia o `WebviewPanel` do VS Code, e trata a mensagem `refresh` vinda dele. Delega o HTML ao `render.ts`. |
| `src/preview/dashboard.ts` | Ferramenta de documentação: escreve o HTML do painel em disco para virar captura. Equivalente ao `-PreviewPath` do tray. |
| `src/daemon.ts` | Processo Node de vida longa que publica o snapshot em disco para a bandeja. |
| `tray/tokenbar.ps1` | Indicador do Windows. Lê o snapshot e desenha ícone/tooltip/painel com GDI+. |
| `tray/tokenbar.vbs` | Sobe o PowerShell sem piscar console. |
| `src/test/test.ts` | Suíte mínima, sem framework: asserções diretas com código de saída. |

## Contrato de dados

Todo coletor devolve um `ProviderSnapshot`:

```ts
{
  provider: 'claude' | 'codex',
  label: string,
  status: 'ok' | 'unavailable' | 'error',
  source: string,          // origem legível, ex.: "Claude Code OAuth"
  collectedAt: string,     // ISO 8601
  plan?: string,
  windows: UsageWindow[],
  message?: string,        // diagnóstico para o usuário
  stale?: boolean          // true quando é cache, não dado fresco
}
```

E cada `UsageWindow`:

```ts
{
  id: string,
  label: string,
  usedPercent: number,     // sempre 0–100, via clampPercent
  resetsAt?: string,       // ISO 8601
  durationMinutes?: number,
  detail?: string
}
```

Regra de ouro: **`usedPercent` é sempre o percentual usado**. A conversão para "restante"
acontece só na camada de apresentação da extensão (`100 - usedPercent`). A bandeja mostra
`usedPercent` direto, para bater com o `/usage` do Claude Code.

### Distinção de estados

- `status: 'unavailable'` — falta pré-requisito do lado do usuário (não logou, CLI ausente,
  conta sem janelas). Não é bug.
- `status: 'error'` — falha inesperada (rede, resposta inválida, processo morreu).
- `stale: true` — o dado é do cache; o `status` continua `'ok'` porque o número exibido é
  válido, só não é fresco.

## Fluxo de atualização

1. `UsageManager.refresh()` dispara `collect()` em todos os coletores **em paralelo**
   (`Promise.all`).
2. Se já houver um refresh em voo, a chamada devolve a mesma promise — não há coleta
   duplicada.
3. Ao resolver, o snapshot vira o estado atual e todos os listeners são notificados.
4. Na extensão, o listener atualiza a barra de status, o painel (se aberto) e o
   `globalState`. No daemon, o listener grava `snapshot.json`.

O snapshot persistido é reinjetado no construtor do `UsageManager` na próxima inicialização,
o que restaura o cache do `ClaudeCollector` — inclusive o carimbo de última tentativa, para
o piso de 5 minutos sobreviver a reinícios.

## Coletor Claude: cache e backoff

Três guardas, nesta ordem:

1. **Backoff ativo** (`backoffUntil`): definido ao receber 429, usando `Retry-After` ou
   10 minutos. Enquanto vigora, devolve cache.
2. **Piso de 5 minutos** (`MIN_REFRESH_MS`): mesmo sem erro, não há chamada de rede antes
   disso. Devolve cache.
3. **Fallback em erro**: qualquer falha com cache disponível devolve o cache com
   `stale: true` e a mensagem do erro, em vez de apagar o número da tela.

Só uma coleta com pelo menos uma janela atualiza o cache e zera o backoff.

## Coletor Codex: handshake

O `codex app-server --stdio` fala JSON por linha (stdin/stdout):

| Direção | Mensagem |
| --- | --- |
| → | `{"method":"initialize","id":1,"params":{clientInfo,capabilities}}` |
| ← | resposta com `id: 1` |
| → | `{"method":"initialized","params":{}}` |
| → | `{"method":"account/rateLimits/read","id":2,"params":null}` |
| ← | resposta com `id: 2` e `result.rateLimits` / `result.rateLimitsByLimitId` |

O buffer de stdout é fatiado por linha, com o resto parcial preservado entre chunks. Assim
que a resposta `id: 2` chega, o processo é encerrado — não fica um app-server pendurado.

Timeout de 12 s. `finish()` é idempotente: erro, sucesso, `exit` e timeout competem, e só
o primeiro vale.

## Estado em disco (bandeja)

Diretório: `%LOCALAPPDATA%\tokenbar\` (fallback para o home do usuário).

| Arquivo | Quem escreve | Quem lê |
| --- | --- | --- |
| `snapshot.json` | `daemon.js`, de forma atômica (`.tmp` + rename) | `tokenbar.ps1` |
| `refresh.flag` | `tokenbar.ps1`, no menu "Atualizar agora" | `daemon.js`, via `fs.watch`, e apaga em seguida |

A escrita atômica evita que a bandeja leia um JSON pela metade. O flag é o único canal de
comando bandeja → daemon; não há socket nem porta aberta.

## Decisões e trade-offs

- **Sem dependências de runtime.** Só `https` e `child_process` do Node. Reduz superfície de
  supply chain e mantém o `.vsix` pequeno.
- **Bundle com esbuild**, não `tsc`. Compilação em milissegundos, um arquivo por alvo.
- **Suíte de testes sem framework.** Cobre o que é puro (`clampPercent`, rotulagem de
  janelas do Codex). Rede e processo filho não são testados — exigiriam mocks que
  custariam mais que o valor entregue neste tamanho de projeto.
- **HTML gerado por template string**, sem framework de webview. Todo dado externo passa por
  `escapeHtml()` antes de ser interpolado.
- **Bandeja em PowerShell**, não num app nativo. Zero build extra no Windows, e o script é
  auditável por quem instala.
- **Bandeja passiva.** Ela não coleta nada; se o daemon cair, o painel mostra dado velho em
  vez de reautenticar por conta própria.

## Como adicionar um provedor

1. Implemente `UsageCollector` em `src/collectors/<nome>.ts`, devolvendo `ProviderSnapshot`.
2. Use `clampPercent()` em todo percentual e `unavailable()` para pré-requisito ausente.
3. Adicione o id ao union `ProviderId` em `src/usage.ts`.
4. Registre a instância no array `collectors` do `UsageManager`.
5. Se a interface tiver cor própria, acrescente a regra `.provider.<id>:before` no CSS do
   dashboard.

Nenhuma alteração é necessária na barra de status, no daemon ou na bandeja — todos
percorrem `snapshot.providers` genericamente.
