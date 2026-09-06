# Changelog

Todas as mudanças relevantes deste projeto são registradas aqui.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto
adota [Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não publicado]

### Codex Spark

- Inclui as cotas próprias do Codex Spark, antes ignoradas quando a resposta também
  continha o limite principal do Codex.
- Mostra `Spark 5h` e `Spark 7d` na seção Codex da bandeja, mantendo a largura compacta,
  sem somar cotas nem duplicar a consulta ao CLI.
- Preserva respostas legadas e contas sem Spark; adiciona testes de seleção, deduplicação,
  validação, recuperação, persistência e apresentação, além das novas capturas dos painéis.

### Antigravity

- Adiciona cotas pelo comando `/usage` do CLI oficial `agy`, sem ler credenciais do Google.
- Separa Gemini e Claude/GPT em janelas de 5 horas e semanal; converte percentual restante
  para usado e mantém quatro linhas curtas na bandeja, sem aumentar sua largura.
- Adapta o dashboard aos três provedores e resume o tooltip quando necessário para que
  nenhum provedor fique oculto pelo limite de texto do Windows.
- Aplica prazo de consulta, limite de saída, mensagens sanitizadas, cache persistente,
  piso de 60 segundos e espera de 5 minutos após limitação de consultas. Adiciona testes
  de parser, falhas, cancelamento, cache, reinício e apresentação.

### Bandeja compacta

- Restaura as dimensões anteriores do painel da bandeja e remove linhas de coleta,
  tentativas, avisos de sessão, asteriscos e o ícone de exclamação.
- Mantém os coletores e identifica dados antigos discretamente com `cache` e cor cinza.

### Confiabilidade das cotas

- Corrige os cinco achados de 05/09: avisos ocultos pelo cache, resposta HTTP pendurada,
  atualização manual ignorando 429, percentual inválido convertido em zero e contagem
  de tempo arredondada.
- Mostra última coleta e próxima tentativa por provedor. Janelas vencidas não preenchem
  barras nem determinam o maior uso; falhas permanecem visíveis junto dos valores anteriores.
- Persiste o intervalo e a espera de 429, inclusive sem uma primeira coleta válida.
- Cancela HTTP após um prazo total de 10 s e coletores após 15 s, publicando cada provedor
  independentemente. Preserva os últimos valores válidos em falhas.
- Adiciona diagnóstico local com rotação e sem credenciais, testes de regressão com
  HTTP em loopback e testes da bandeja no CI Windows.

### Adicionado

- Documentação do projeto: `README.md` expandido, `docs/arquitetura.md`, `SECURITY.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` e este changelog.
- `.gitignore` e workflow de CI no GitHub Actions (compilação e testes em push e PR).
- Metadados de repositório no `package.json` (`license`, `repository`, `bugs`, `homepage`).
- Capturas do painel da bandeja e do painel da extensão no `README.md`, ambas geradas pelo
  próprio projeto — a primeira pelo `-PreviewPath` do tray, a segunda pelo novo
  `dist/preview.js`.
- `npm run compile-preview` e `src/preview/dashboard.ts`: escrevem o HTML do painel em disco
  para virar captura, a partir do snapshot do daemon ou de um JSON de exemplo.

### Alterado

- **A extensão passa a mostrar o percentual _usado_, não o restante** — o mesmo número da
  bandeja e do `/usage` do Claude Code. Vale para a barra de status, o tooltip e o painel;
  a barra de progresso agora enche conforme a cota é consumida, em vez de esvaziar. As
  faixas de cor da extensão foram alinhadas às da bandeja: verde abaixo de 70%, âmbar a
  partir de 70%, vermelho a partir de 90%.
- O HTML do painel saiu de `src/webview/dashboard.ts` para `src/webview/render.ts`, agora
  livre de `import vscode` — é o que permite renderizá-lo fora do editor. O `dashboard.ts`
  segue responsável pelo `WebviewPanel` e pelas mensagens. Sem mudança de comportamento.

### Corrigido

- **O backoff de 429 e o piso de 5 minutos do coletor Claude passam a valer sem cache.** As
  duas guardas dependiam de haver um snapshot guardado, então uma instalação que ainda não
  tinha coletado com sucesso — ou que tomasse 429 antes da primeira coleta — consultava o
  endpoint a cada refresh (15–60 s), justamente quando o serviço pediu para esperar. A
  decisão de cadência virou a função pura `claudeThrottleReason()`, que não recebe o cache
  e por isso não tem como voltar a acoplar as duas coisas. Coberta por teste.
- **O daemon não morre mais quando a bandeja está lendo o `snapshot.json`.** No Windows,
  renomear por cima de um arquivo aberto para leitura falha com `EPERM`. A exceção subia
  pelo listener do `UsageManager`, rejeitava o refresh e, sem ninguém para capturá-la,
  encerrava o processo — levando junto o `backoffUntil`, que só existe em memória. A
  publicação agora repete a cada 500 ms até passar, e o daemon tem rede de segurança para
  rejeições não tratadas.
- A extensão captura falhas de coleta na ativação e no agendamento, em vez de deixar a
  ativação abortar ou uma promise rejeitada solta no extension host.
- O coletor Codex procura o CLI também no PATH, não só em `%APPDATA%\npm\codex.cmd`. Quem
  usa nvm-windows, Volta, pnpm ou um `npm prefix` próprio via "Codex CLI não foi
  encontrado" mesmo com o `codex` instalado e funcionando.
- A barra de status ignora provedores `ok` sem nenhuma janela, em vez de contar com a
  garantia implícita de que isso nunca acontece.

### Alterado

- `src/version.ts` centraliza a versão anunciada aos provedores (`User-Agent` do Claude e
  `clientInfo` do Codex), que estava congelada em `0.1.0` desde a primeira release. Um
  teste falha se ela divergir do `package.json`.
- `activationEvents` perdeu as entradas `onCommand:`, redundantes desde o VS Code 1.74.
- `@types/vscode` fixado em `1.75.0`, igual ao mínimo declarado em `engines.vscode`, para o
  typecheck não aceitar API que não existe na versão suportada.
- `dist/daemon.js` saiu do `.vsix` — a bandeja roda a partir do repositório, não da
  extensão instalada.
- esbuild 0.17 → 0.28 e TypeScript 4.9 → 7.0 (dependências de desenvolvimento), zerando os
  avisos do `npm audit`. O TypeScript 7 não inclui mais os pacotes `@types` automaticamente,
  então o `tsconfig.json` passou a declarar `"types": ["node"]`.
- `@types/node` segue em 18 e `@types/vscode` em 1.75.0 de propósito: os tipos ficam na
  versão mais antiga que o projeto suporta, para o typecheck não aceitar API inexistente em
  produção. O `npm outdated` vai reclamar dos dois; está documentado no `CONTRIBUTING.md`.

### Segurança

- O painel agora declara `Content-Security-Policy` com nonce por renderização e restringe
  `localResourceRoots` ao diretório da extensão. O handler inline do botão "Atualizar agora"
  virou `addEventListener`, exigido pela CSP. Sem mudança de comportamento visível.

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
