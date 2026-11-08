# Achados de auditoria — TokenBar

Auditoria de 21/10/2026, HEAD `e7c3a9cbc79cfe2f7617dabd01ed73653a45c571`. Sem IDs numéricos anteriores no Git. Relatório externo: `C:\Codes\relatorios\tokenbar\auditoria-2026-10-21.md`.

| ID | Severidade | Status | Título e evidência |
|---|---|---|---|
| #1 | Baixa | RESOLVIDO (23/10/2026) | Envelope JSON `null` do Codex escapava do catch e gerava uncaughtException. `src/collectors/codex.ts`: o callback de `data` encaminha toda falha para `finish`, ignora envelopes que não são objeto (como já ignorava linhas que não são JSON), valida `result` como objeto, limita cada linha a 256 KiB, ignora dados após o settlement e reduz a mensagem de erro do provedor a texto de uma linha com até 200 caracteres (cobre o PARCIAL I2). Três regressões em `src/test/codexSpark.ts`, com processo falso, falham contra o código anterior; o probe da auditoria não reproduz mais a exceção. |
| #2 | Baixa | RESOLVIDO (23/10/2026) | Tooling VSCE com 12 entradas npm audit. Transitivas atualizadas no lockfile sem `--force` (brace-expansion, fast-uri, js-yaml, markdown-it, qs, undici) e `@vscode/vsce` 3.9.2 → 4.0.0, que remove a cadeia secretlint/globby/braces sem correção na 3.x. `npm audit`: 0 vulnerabilidades. `npm ci`, tipos, testes e `vsce package` validados em cópia isolada; conteúdo do VSIX inalterado. vsce 4 exige Node ≥ 22. Depois, ainda em 23/10/2026, o vsce saiu do projeto junto com a extensão do VS Code. |
| #3 | Média | RESOLVIDO (23/10/2026) | CI fixava Node 20 (EOL). `.github/workflows/ci.yml` usa `node-version-file: .node-version`, com a linha LTS 24; README atualizado (o "Node 18+" anterior já não atendia o vsce). Fixada a linha principal, não o patch, para receber as correções de segurança da linha. Validado localmente em Node 24.11.1 e no CI remoto (run 39929792945, Node 24.21.0, ubuntu e windows PASS). A compatibilidade com VS Code 1.75 deixou de se aplicar: a extensão foi removida em 23/10/2026. |

Validações da auditoria: 78 testes TypeScript + 41 checks PowerShell PASS; tipos e build PASS, repetidos com toolchain do lockfile em diretório externo após detectar instalação local defasada. Sem teste de GUI, credenciais, CLI real, Marketplace ou produção.

Validações da resolução (23/10/2026, Node 24.11.1, `npm ci` limpo em cópia isolada): `tsc --noEmit` PASS, `npm run compile` PASS, 81 testes TypeScript PASS (78 + 3 novos), 41 checks PowerShell PASS, `npm run package` PASS, `npm audit` 0. Não há script de lint.


## Rodada transversal 2026-10-30 — 200000

HEAD auditado: `7c2fb250429fad67708b1f42459fada76f0f405f`. Relatório externo: `C:\Codes\relatorios\tokenbar\auditoria-2026-10-30-200000.md`. Evidências: `C:\Codes\relatorios\tokenbar\evidencias-2026-10-30-200000.json`.

Auditoria estática e validações selecionadas; sem correção de código, commit, push ou deploy. Falta de prova operacional não foi convertida em vulnerabilidade presumida.

Nenhum achado novo consolidado nesta rodada; nenhum ID reservado. Isto não equivale à ausência de falhas ou aprovação de release; ver limitações do relatório.

Reverificações e decisões históricas: #1 — Correção preservada; #2 — Sem reincidência no audit atual; #3 — Linha Node 24 mantida; patch do runner não revalidado. O relatório detalha alcance/evidência; provas operacionais antigas não foram repetidas.

## Auditoria transversal — rodada 2026-11-06, concluída em 07/11

HEAD `7c2fb250429fad67708b1f42459fada76f0f405f`; alvo explícito `C:\Codes\tokenbar`.
Relatório: `C:\Codes\relatorios\tokenbar\auditoria-2026-11-06.md`.
Evidências: `C:\Codes\relatorios\tokenbar\evidencias-2026-11-06\`.
A alteração local anterior (adendo 30/10) foi preservada; cópia inicial em evidências. Nenhum código, teste original, configuração ou dependência alterado.

| ID | Severidade | Status | Título e evidência |
|---|---|---|---|
| #4 | Baixa | ABERTO; reproduzido em fixture | Cancelamento do coletor encerra o wrapper, mas pode deixar o descendente ativo. src/collectors/codex.ts:171–184,257–267,280–317; src/daemon.ts:94. Detalhes e limites no relatório. |
| #5 | Baixa | ABERTO (potencial) | Autostart pressupõe powershell.exe dentro do host PowerShell atual. tray/tokenbar.ps1:1,371–381; README.md:29,48. Detalhes e limites no relatório. |
| #6 | Baixa | ABERTO (potencial) | Teste de falha de log usa um caminho fora da fixture. src/test/tray.test.ps1:109; tray/state.ps1:39–47. Detalhes e limites no relatório. |
| #7 | Baixa | ABERTO (potencial) | Cotas detalhadas do painel não têm representação semântica de acessibilidade. tray/tokenbar.ps1:180,199,203,334–345,363; tray/state.ps1:177–210. Detalhes e limites no relatório. |

Quatro achados novos baixos, nenhum crítico/alto/médio. #1–#3 permanecem resolvidos no código; patch efetivo do runner remoto não atestado nesta rodada. Próximo ID: **8**.

69 testes TypeScript e 41 checks PowerShell PASS; tipos/build/parser dos três scripts PASS; npm audit0. Harness PowerShell em cópia TEMP com o alvo externo Z: substituído por caminho interno à fixture, sem alterar a suíte original. Probe do coletor Codex real com wrapper/descendente sintéticos reproduziu sobrevivência após cancelamento; processo encerrou sozinho aos5s e ausência do PID foi conferida. Nove pares de cores opacas medidos: mínimo6,19:1.

Sem daemon/tray/CLI real, credenciais, estado externo, serviço de conta, GUI/Narrator/PowerShell7 operacional, autostart ou publicação. Extensão VS Code removida é decisão preservada. Baseline52:9PASS/2PARCIAL/41N-A, conforme arquitetura desktop.

A revisão automática bloqueou a remoção de `%TEMP%\codex-auditoria-tokenbar-20261106` (`blocked by policy`) antes da execução. Pasta retida com helpers/fixtures/cache; nenhum processo próprio ativo e nenhum contorno do bloqueio. Memória registrada em default/tokenbar.

