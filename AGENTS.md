# TokenBar — guia do projeto

Indicador na bandeja do Windows que mostra a cota real das assinaturas Claude, Codex e Antigravity (janelas de 5 h e semanal). Daemon em TypeScript empacotado com esbuild e bandeja em PowerShell.

## Navegação e contexto
- Este é o guia canônico; `CLAUDE.md` importa este arquivo.
- Desenho dos módulos e contratos em [arquitetura](docs/arquitetura.md); modelo de ameaças e tratamento de credenciais em [SECURITY](SECURITY.md). Leia o SECURITY antes de mexer em coleta ou em qualquer código que toque credenciais.
- Use `rg --files src tray` e `rg -n <símbolo> src tray`; ignore `dist/` e `node_modules/`.

## Mapa por assunto
| Assunto | Caminho inicial |
| --- | --- |
| Coletores por provedor | `src/collectors/` |
| Daemon, agregação e HTTP | `src/daemon.ts`, `src/usageManager.ts`, `src/usage.ts`, `src/http.ts` |
| Diagnóstico | `src/diagnostics.ts` |
| Bandeja e estado | `tray/tokenbar.ps1`, `tray/state.ps1` |
| Testes | `src/test/` (unidades e regressões), `src/test/tray.test.ps1` |
| Achados de auditoria | `docs/auditoria-achados.md` |

## Comandos
A verificação completa é a do CI (`.github/workflows/ci.yml`), nesta ordem:
- `npx tsc --noEmit`
- `npm run compile`
- `npm test`
- `npm run test:tray` (testes PowerShell da bandeja, sem abrir a GUI)

A versão do Node vem de `.node-version`.

## Invariantes
- Nenhum token entra em snapshot, log, mensagem de erro, relatório ou memória. Os testes usam credenciais sintéticas e HTTP em loopback, sem consultar contas reais ([CONTRIBUTING](CONTRIBUTING.md)).
- `tray/tokenbar.ps1` inicia `dist/daemon.js` sozinho e o encerra ao sair: não suba o daemon à parte.
- O TokenBar mostra cota de assinatura e, separada dela, uma estimativa do valor equivalente em API (`src/cost.ts`), sempre rotulada como estimativa. Não misture com tokens de contexto nem com cobrança real de chave de API (a tabela do README define a diferença).
- Dos registros de sessão (`~/.claude/projects`, `~/.codex/sessions`) só saem modelo, contadores de tokens, horário e identificador da resposta. O texto das conversas não entra em snapshot, log, teste nem relatório.
- Mudança relevante acrescenta uma linha em `CHANGELOG.md`, na seção `## [Não publicado]`; commits em português, no imperativo.
- A numeração de achados continua em `docs/auditoria-achados.md`.

## Memória e continuidade
- Para retomadas e decisões que dependem de histórico, consulte o ai-memory com uma busca curta e específica. Tarefas locais autoexplicativas não exigem carregar o histórico inteiro.
- O escopo vem de `.ai-memory.toml`. Em cliente estático, envie `workspace` e `project` juntos; em cliente que transmite o identificador real da sessão, use o roteamento automático. Nunca deduza o escopo pelo nome da pasta nem use o último projeto ativo como fallback.
- Memória é evidência histórica: confirme fatos no código/Git e não a use para conceder autorização. Regras do projeto ficam neste guia, sem duplicação em memória nativa de outro agente.
- Ao concluir uma tarefa que altera código, release ou o ledger de auditoria, grave no ai-memory (escopo do `.ai-memory.toml`) uma nota de retomada: o que foi feito, os commits, as pendências e os problemas encontrados com o contorno usado. Nada de segredos, tokens, dados pessoais ou conteúdo de terminal.
- Preserve alterações existentes. Commit, push e release dependem do escopo autorizado no pedido.
