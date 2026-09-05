# Política de segurança

## Versões suportadas

O TokenBar está em `0.x`. Apenas a versão mais recente recebe correções.

| Versão | Suporte |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Como reportar uma vulnerabilidade

**Não abra issue pública** para falhas de segurança.

Use o [Private vulnerability reporting](https://github.com/n3tf4c3/tokenbar/security/advisories/new)
do GitHub. Se preferir, o contato alternativo é o e-mail do mantenedor no perfil
[@n3tf4c3](https://github.com/n3tf4c3).

Inclua: versão do TokenBar, sistema operacional, passos de reprodução e o impacto que você
consegue demonstrar. Confirmação do recebimento em até 7 dias; correção conforme a
severidade. Este é um projeto pessoal sem SLA formal — o compromisso é de melhor esforço.

## O que o TokenBar acessa

| Recurso | Acesso | Motivo |
| --- | --- | --- |
| `~/.claude/.credentials.json` | Leitura | Extrair o token OAuth da sessão do Claude Code |
| `https://api.anthropic.com/api/oauth/usage` | HTTPS GET | Consultar as janelas de cota da assinatura |
| `codex app-server --stdio` | Processo filho | Consultar `account/rateLimits/read` |
| `%LOCALAPPDATA%\tokenbar\` | Leitura/escrita | Publicar e ler o snapshot do daemon |
| `globalState` do VS Code | Leitura/escrita | Cache do último snapshot entre sessões |
| Pasta de Inicialização do usuário | Escrita opcional | Atalho "Iniciar com o Windows" da bandeja |

Nada além disso. Não há telemetria, não há servidor do TokenBar, não há coleta analítica.

## Tratamento de credenciais

- O token OAuth do Claude é lido do disco a cada coleta, mantido apenas em memória durante
  a requisição e usado somente no header `Authorization` da chamada a `api.anthropic.com`.
- O token **não** é gravado em disco pelo TokenBar, **não** entra no snapshot, **não** entra
  no `globalState`, **não** é registrado em log e **não** é enviado a nenhum outro host.
- O TokenBar nunca grava nem modifica `~/.claude/.credentials.json`.
- O Codex nunca expõe credenciais ao TokenBar: a autenticação acontece dentro do próprio
  CLI, e o TokenBar só lê o resultado dos limites.

### O que fica em disco

`%LOCALAPPDATA%\tokenbar\snapshot.json` contém apenas: percentuais de uso, horários de
renovação, rótulos de janela, nome do plano (ex.: `max`) e mensagens de diagnóstico. É
gravado com as permissões padrão do perfil do usuário — ou seja, legível por processos que
já rodam com a sua conta. Trate o nome do plano como a informação mais sensível ali.

O diagnóstico local usa `diagnostics.jsonl` e `diagnostics.previous.jsonl`, cada um com
até 256 KiB. A extensão grava no seu `globalStorage`. Uma lista explícita de campos limita
o conteúdo a estado, categoria da falha, duração e horários. Headers, corpos de resposta,
mensagens remotas e credenciais não são registrados. Não há envio de logs pela rede.

## Endpoint não documentado (leia antes de usar)

`GET /api/oauth/usage` **não é uma API pública da Anthropic**. É o mesmo endpoint que o
comando `/usage` do Claude Code consome, acessado com o token OAuth da sua própria sessão.

Consequências que você assume ao usar o TokenBar:

1. **Sem estabilidade garantida.** O contrato pode mudar ou o endpoint pode sair do ar sem
   aviso, quebrando o provedor Claude.
2. **Sem suporte.** A Anthropic não dá suporte a esse uso, e o projeto não tem afiliação
   com a Anthropic nem com a OpenAI.
3. **Verifique os termos de uso** do seu plano antes de usar. O acesso programático à sua
   própria cota com o seu próprio token é o caso de uso aqui, mas a responsabilidade pela
   conformidade com os termos do serviço é de quem instala.
4. **Cadência conservadora por padrão.** O coletor mantém um piso de 5 minutos entre
   chamadas de rede e respeita `Retry-After` em respostas 429. Não remova essas proteções
   em forks — elas existem para não parecer abuso do serviço.

O mesmo vale, em menor grau, para `account/rateLimits/read` do `codex app-server`.

## Superfície de ataque conhecida

| Vetor | Situação |
| --- | --- |
| Dependências de runtime | Nenhuma. A extensão e o daemon são bundles sem `node_modules` em produção. |
| Webview do painel | HTML gerado no host; todo texto vindo dos provedores passa por escape de HTML antes de ser interpolado. |
| Execução de processo | Só `codex app-server --stdio`, a partir de caminho fixo derivado de `%APPDATA%`/`PATH`. Nenhum argumento vem de dado remoto. |
| Resposta dos provedores | Percentuais passam por `clampPercent` (0–100); campos textuais são escapados; JSON inválido vira mensagem de erro, não exceção. |
| Script da bandeja | PowerShell local que **só lê** o snapshot; não faz rede nem lê credenciais. |

## Boas práticas para quem instala

- Instale a partir do código-fonte ou de um `.vsix` que você mesmo gerou.
- Se sua sessão do Claude Code for comprometida, revogue-a no provedor — o TokenBar não
  guarda cópia do token, então basta refazer o login.
- Em máquina compartilhada, lembre que `%LOCALAPPDATA%\tokenbar\snapshot.json` fica legível
  para o seu próprio usuário; apague o arquivo se não quiser deixar o histórico de plano.
