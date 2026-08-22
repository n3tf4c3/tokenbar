# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto
adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Adicionado

- Documentação do projeto: `README.md` expandido, `docs/arquitetura.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` e este changelog.
- `.gitignore` e workflow de CI no GitHub Actions (compilação e testes em push e PR).

## [0.1.1]

### Adicionado

- Indicador na bandeja do Windows (`tray/tokenbar.ps1`), para acompanhar as cotas fora do
  VS Code — Zed, Antigravity ou qualquer outro editor.
- Daemon (`src/daemon.ts`) que mantém o coletor vivo e publica
  `%LOCALAPPDATA%\tokenbar\snapshot.json` de forma atômica.
- Canal de comando `refresh.flag`: o menu "Atualizar agora" da bandeja pede uma coleta ao
  daemon sem abrir porta de rede.
- Opção "Iniciar com o Windows" e renderização do painel em PNG via `-PreviewPath`.

## [0.1.0]

### Adicionado

- Extensão do VS Code com indicador na barra de status mostrando a janela mais crítica.
- Painel (`TokenBar: Open Dashboard`) com uma barra por janela de cota, estado do provedor
  e horário de renovação.
- Coletor Claude: lê a sessão OAuth do Claude Code e reporta a janela de 5 horas, a semanal
  e os limites semanais separados por modelo. Inclui cache de 5 minutos, backoff de 429 e
  tradução de erros para mensagens acionáveis.
- Coletor Codex: consulta `account/rateLimits/read` via `codex app-server --stdio`,
  identificando as janelas pela duração retornada.
- Configuração `tokenbar.refreshInterval` (15–3600 s, padrão 60).
- Persistência do último snapshot no `globalState`, para o indicador já abrir com número.

[Não publicado]: https://github.com/n3tf4c3/tokenbar/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/n3tf4c3/tokenbar/releases/tag/v0.1.1
[0.1.0]: https://github.com/n3tf4c3/tokenbar/releases/tag/v0.1.0
