# Achados de auditoria — TokenBar

Auditoria de 21/10/2026, HEAD `e7c3a9cbc79cfe2f7617dabd01ed73653a45c571`. Sem IDs numéricos anteriores no Git. Relatório externo: `C:\Codes\relatorios\tokenbar\auditoria-2026-10-21.md`.

| ID | Severidade | Status | Título e evidência |
|---|---|---|---|
| #1 | Baixa | RESOLVIDO (23/10/2026) | Envelope JSON `null` do Codex escapava do catch e gerava uncaughtException. `src/collectors/codex.ts`: o callback de `data` encaminha toda falha para `finish`, ignora envelopes que não são objeto (como já ignorava linhas que não são JSON), valida `result` como objeto, limita cada linha a 256 KiB, ignora dados após o settlement e reduz a mensagem de erro do provedor a texto de uma linha com até 200 caracteres (cobre o PARCIAL I2). Três regressões em `src/test/codexSpark.ts`, com processo falso, falham contra o código anterior; o probe da auditoria não reproduz mais a exceção. |
| #2 | Baixa | RESOLVIDO (23/10/2026) | Tooling VSCE com 12 entradas npm audit. Transitivas atualizadas no lockfile sem `--force` (brace-expansion, fast-uri, js-yaml, markdown-it, qs, undici) e `@vscode/vsce` 3.9.2 → 4.0.0, que remove a cadeia secretlint/globby/braces sem correção na 3.x. `npm audit`: 0 vulnerabilidades. `npm ci`, tipos, testes e `vsce package` validados em cópia isolada; conteúdo do VSIX inalterado. vsce 4 exige Node ≥ 22. |
| #3 | Média | RESOLVIDO (23/10/2026) | CI fixava Node 20 (EOL). `.github/workflows/ci.yml` usa `node-version-file: .node-version`, com a linha LTS 24; README atualizado (o "Node 18+" anterior já não atendia o vsce). Fixada a linha principal, não o patch, para receber as correções de segurança da linha. Validado localmente em Node 24.11.1; execução no CI remoto pendente do próximo push. Compatibilidade real com VS Code 1.75 não testada (o `engines` não mudou). |

Validações da auditoria: 78 testes TypeScript + 41 checks PowerShell PASS; tipos e build PASS, repetidos com toolchain do lockfile em diretório externo após detectar instalação local defasada. Sem teste de GUI, credenciais, CLI real, Marketplace ou produção.

Validações da resolução (23/10/2026, Node 24.11.1, `npm ci` limpo em cópia isolada): `tsc --noEmit` PASS, `npm run compile` PASS, 81 testes TypeScript PASS (78 + 3 novos), 41 checks PowerShell PASS, `npm run package` PASS, `npm audit` 0. Não há script de lint.
