# Arquitetura

## Visão geral

O TokenBar tem **três coletores** e **dois consumidores**. Todo o código de rede/IPC vive em
`src/collectors/`; a extensão do VS Code e o daemon da bandeja apenas embrulham o mesmo
`UsageManager`.

```
   UsageManager (dedupe de refresh + eventos independentes)
   ├── ClaudeCollector      → HTTPS + OAuth → api.anthropic.com
   ├── CodexCollector       → processo filho → codex app-server --stdio
   └── AntigravityCollector → processo filho → agy --print '/usage'

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
| `src/version.ts` | Versão anunciada aos provedores. Existe para não repetir literal em dois coletores; um teste falha se divergir do `package.json`. |
| `src/usage.ts` | Tipos do domínio (`UsageWindow`, `ProviderSnapshot`, `UsageSnapshot`), o contrato `UsageCollector` e dois helpers: `unavailable()` e `clampPercent()`. |
| `src/usageManager.ts` | Orquestra os coletores. Deduplica refreshes concorrentes, guarda o último snapshot e notifica listeners. |
| `src/collectors/claude.ts` | Lê a sessão OAuth do Claude Code e consulta as janelas de cota. Cache, backoff e tradução de erros. |
| `src/collectors/codex.ts` | Sobe o `codex app-server` e lê a cota principal e as janelas próprias do Spark na mesma consulta. |
| `src/collectors/antigravity.ts` | Executa `/usage` no CLI oficial, valida TSV, converte restante em usado e preserva cache/esperas. |
| `src/http.ts` | HTTP com prazo total, cancelamento, limite de tamanho e resposta incompleta. |
| `src/diagnostics.ts` | Log local com campos permitidos e rotação de dois arquivos de 256 KiB. |
| `tray/state.ps1` | Cálculos de idade, tempo e avisos sem GUI, compartilhados com os testes. |
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
  provider: 'claude' | 'codex' | 'antigravity',
  label: string,
  status: 'ok' | 'unavailable' | 'error',
  source: string,          // origem legível, ex.: "Claude Code OAuth"
  collectedAt: string,     // ISO 8601
  plan?: string,
  windows: UsageWindow[],
  message?: string,        // diagnóstico para o usuário
  stale?: boolean,         // os valores vêm do cache
  checkedAt?: string,      // última verificação local
  lastAttemptAt?: string,  // última tentativa de consulta ao provedor
  nextRetryAt?: string,    // próxima consulta permitida
  retryReason?: 'interval' | 'rate-limit',
  failureKind?: 'auth' | 'rate-limit' | 'network' | 'timeout' | 'invalid-response'
}
```

E cada `UsageWindow`:

```ts
{
  id: string,
  label: string,
  shortLabel?: string,     // rótulo compacto opcional, ex.: "Gem 5h"
  usedPercent: number,     // sempre 0–100, via clampPercent
  resetsAt?: string,       // ISO 8601
  durationMinutes?: number,
  detail?: string
}
```

Regra de ouro: **`usedPercent` é sempre o percentual usado**, do coletor até a tela. Nenhuma
camada de apresentação inverte o sinal — barra de status, painel da extensão e bandeja
mostram `usedPercent` direto, para bater com o `/usage` do Claude Code.

As faixas de cor derivam do mesmo número e são iguais nas duas interfaces: verde abaixo de
70%, âmbar a partir de 70%, vermelho a partir de 90%. Implementadas em `toneFor()`
(`src/webview/render.ts`) e `Get-Tone` (`tray/tokenbar.ps1`) — são duas linguagens, então
os cortes estão duplicados; ao mexer numa, mexa na outra.

### Distinção de estados

- `status: 'unavailable'` — falta pré-requisito do lado do usuário (não logou, CLI ausente,
  conta sem janelas). Não é bug.
- `status: 'error'` — falha inesperada (rede, resposta inválida, processo morreu).
- `stale: true` — os valores são do cache. O estado da última falha permanece em `status`,
  `failureKind` e `message`; somente o cache do intervalo normal tem `status: 'ok'`.
- O `collectedAt` por provedor preserva o horário da última leitura válida quando há cache.
  O horário geral indica publicação do painel, não coleta de todos os serviços.
- Janelas vencidas deixam de determinar o ícone e ficam sem preenchimento. Na bandeja,
  dados sem coleta há 10 minutos ficam em cinza, com `cache` no cabeçalho do provedor.
  Os avisos detalhados ficam no painel da extensão. As interfaces recalculam a idade localmente.

## Fluxo de atualização

1. `UsageManager.refresh()` dispara `collect()` em todos os coletores **em paralelo**
   (`Promise.all`).
2. Se já houver um refresh em voo, a chamada devolve a mesma promise — não há coleta
   duplicada.
3. Cada provedor publica seu resultado assim que resolve. O prazo individual de 15 s
   aborta a consulta, publica o erro e libera novas coletas. Respostas atrasadas de uma
   consulta cancelada não substituem resultados posteriores.
4. Na extensão, o listener atualiza a barra de status, o painel (se aberto) e o
   `globalState`. No daemon, o listener grava `snapshot.json`.

O snapshot persistido é reinjetado no construtor do `UsageManager` na próxima inicialização,
o que restaura o cache de Claude e Antigravity, `lastAttemptAt` e `nextRetryAt` de 429,
inclusive se o estado não contém janelas. Snapshots legados seguem compatíveis.

## Coletor Claude: cache e backoff

Três guardas, nesta ordem:

1. **Backoff ativo** (`backoffUntil`): definido ao receber 429, usando `Retry-After` ou
   5 minutos. Esperas maiores informadas pelo serviço não são encurtadas.
2. **Piso de 5 minutos** (`MIN_REFRESH_MS`): mesmo sem erro, não há chamada de rede antes
   disso.
3. **Fallback em erro**: qualquer falha com cache disponível devolve o cache com
   `stale: true`, estado de falha e mensagem visível, preservando a leitura anterior.

As duas primeiras são decididas por `claudeThrottleReason()`, uma função pura que recebe
só os três carimbos de tempo. Ela **não sabe se existe cache**, e isso é proposital: a
versão anterior condicionava as guardas a haver um snapshot guardado, então uma instalação
que ainda não tinha coletado com sucesso ignorava tanto o piso quanto o backoff. Quem
decide o que *mostrar* enquanto a consulta está travada é `currentSnapshot()` — cache, se houver;
senão o último diagnóstico, que é mais útil ao usuário que um "aguarde".

Só uma coleta com pelo menos uma janela válida atualiza o cache e zera o backoff.
Atualizações manuais respeitam as mesmas guardas. O HTTP tem prazo total de 10 s, trata
`error`, `aborted` e encerramento incompleto e limita o corpo a 1 MiB.

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

`rateLimits` é a visão legada de um único limite; `rateLimitsByLimitId` contém os limites
separados. `selectCodexLimits()` prefere a entrada `codex` desse mapa e inclui o Spark,
deduplicando o limite que também veio na visão legada. Se `limitId` estiver ausente,
preserva a chave do mapa. Reservas e outros limites não são adicionados ao par Codex/Spark.

Spark é reconhecido pelo nome/ID contendo o termo `Spark` ou por `codex_bengalfox`, o ID
observado no CLI com `limitName: "GPT-5.3-Codex-Spark"`. Continua no provedor `codex`, com
IDs próprios nas janelas. A duração define `Spark 5h` e `Spark 7d` em `shortLabel`; o
dashboard usa o nome completo do período. Não há segundo coletor, processo ou chamada.
Contas sem janelas do Spark continuam mostrando apenas as cotas existentes, sem inventar zero.

## Coletor Antigravity: comando de cotas

Executa o binário nativo `agy` com argumentos fixos `--print /usage --print-timeout 10s`,
via `execFile`, sem shell, no diretório temporário do sistema e com janela oculta. Procura
na instalação padrão do usuário e no PATH. O CLI gerencia a própria autenticação.

O parser aceita linhas TSV com quatro campos: grupo, período, percentual restante e
renovação ISO. Os grupos conhecidos são `Gemini Models` e `Claude and GPT models`; os
períodos são `Five Hour Limit Remaining` e `Weekly Limit Remaining`. Grupos parciais são
aceitos, mas campos inválidos, janelas duplicadas e formatos desconhecidos falham sem
inventar cotas. O percentual restante é convertido uma única vez para usado.

Os IDs distinguem grupo e período (`antigravity_gemini_five_hour`, por exemplo).
`label` identifica ambos no dashboard; `shortLabel` permite `Gem 5h`, `Gem sem`, `C/G 5h`
e `C/G sem` na bandeja, mantendo sua largura. Essas cotas não são somadas às de Claude/Codex.

O processo tem timeout externo de 12 s, sinal de cancelamento e limite de saída de 64 KiB.
Falhas viram mensagens locais, nunca stdout/stderr brutos. CLI ausente ou autenticação
necessária ficam `unavailable`. Há piso de 60 s entre tentativas e espera de 5 min após
limitação de consultas, inclusive no refresh manual e após reinício. Falhas preservam as
últimas janelas e seu `collectedAt`.

## Estado em disco (bandeja)

Diretório: `%LOCALAPPDATA%\tokenbar\` (fallback para o home do usuário).

| Arquivo | Quem escreve | Quem lê |
| --- | --- | --- |
| `snapshot.json` | `daemon.js`, de forma atômica (`.tmp` + rename) | `tokenbar.ps1` |
| `refresh.flag` | `tokenbar.ps1`, no menu "Atualizar agora" | `daemon.js`, via `fs.watch`, e apaga em seguida |

O daemon grava `diagnostics.jsonl` e `diagnostics.previous.jsonl`, com rotação em 256 KiB.
Os logs contêm apenas estado, duração e horários; mensagens remotas e credenciais não entram.

A escrita atômica evita que a bandeja leia um JSON pela metade. O flag é o único canal de
comando bandeja → daemon; não há socket nem porta aberta.

O rename é atômico, mas não é infalível: no Windows ele falha com `EPERM` se a bandeja
estiver com o `snapshot.json` aberto naquele instante. O daemon guarda o snapshot pendente
e repete a cada 500 ms até publicar. Falhas de publicação ficam no diagnóstico. O gerenciador
também isola exceções dos listeners para não impedir outros consumidores ou novas coletas.
O backoff confirmado é persistido junto do snapshot.

## Decisões e trade-offs

- **Sem dependências de runtime.** Só `https` e `child_process` do Node. Reduz superfície de
  supply chain e mantém o `.vsix` pequeno.
- **Bundle com esbuild**, não `tsc`. Compilação em milissegundos, um arquivo por alvo.
- **Suíte sem framework externo.** Unidades e regressões cobrem autenticação expirada,
  429, reinício, cache vencido, campos inválidos, prazo total, publicação independente e
  rotação de logs. Um servidor em loopback simula HTTP interrompido e lento; credenciais
  são sintéticas. O CI roda em Linux e Windows, com testes PowerShell para a bandeja.
- **HTML gerado por template string**, sem framework de webview. Todo dado externo passa por
  `escapeHtml()` antes de ser interpolado.
- **Bandeja em PowerShell**, não num app nativo. Zero build extra no Windows, e o script é
  auditável por quem instala.
- **Bandeja passiva.** Ela não coleta nem reautentica. Dados antigos são sinalizados mesmo
  sem novas publicações. O usuário renova sua sessão no Claude Code.

## Como adicionar um provedor

1. Implemente `UsageCollector` em `src/collectors/<nome>.ts`, devolvendo `ProviderSnapshot`.
2. Use `clampPercent()` em todo percentual e `unavailable()` para pré-requisito ausente.
3. Adicione o id ao union `ProviderId` e ao mapa `PROVIDER_LABELS` em `src/usage.ts`.
4. Registre a instância no array `collectors` do `UsageManager`.
5. Se a interface tiver cor própria, acrescente a regra `.provider.<id>:before` no CSS do
   dashboard.

Nenhuma alteração é necessária na barra de status, no daemon ou na bandeja — todos
percorrem `snapshot.providers` genericamente.
