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
| Loja de certificados raiz do Windows | Leitura | Validar a conexão quando um antivírus ou proxy inspeciona o HTTPS (veja abaixo) |
| `codex app-server --stdio` | Processo filho | Consultar `account/rateLimits/read` |
| `agy --print /usage --print-timeout 10s` | Processo filho nativo | Ler cotas pelo comando oficial do Antigravity |
| `%LOCALAPPDATA%\tokenbar\` | Leitura/escrita | Publicar e ler o snapshot do daemon |
| Agendador de Tarefas (tarefa `\TokenBar`, usuário atual, sem elevação) | Escrita opcional | "Iniciar com o Windows" da bandeja |
| Pasta de Inicialização do usuário | Remoção do `TokenBar.lnk` | Migração do atalho de versões anteriores |

Nada além disso. Não há telemetria, não há servidor do TokenBar, não há coleta analítica.

## Tratamento de credenciais

- O token OAuth do Claude é lido do disco a cada coleta, mantido apenas em memória durante
  a requisição e usado somente no header `Authorization` da chamada a `api.anthropic.com`.
- O token **não** é gravado em disco pelo TokenBar, **não** entra no snapshot, **não** entra
  em diagnóstico, **não** é registrado em log e **não** é enviado a nenhum outro host.
- O TokenBar nunca grava nem modifica `~/.claude/.credentials.json`.
- Codex e Antigravity autenticam dentro dos próprios CLIs. O TokenBar só consulta os
  limites; não lê nem exporta as credenciais do Google.
- A saída bruta do Antigravity não entra em snapshot ou log. Erros são classificados e
  substituídos por mensagens locais, sem URLs de login ou detalhes da conta.

### Conexão inspecionada por antivírus ou proxy

A consulta ao Claude é validada primeiro só com as autoridades certificadoras embutidas no
Node. Antivírus que inspecionam HTTPS (o Kaspersky, por exemplo) e proxies corporativos
reassinam a conexão com uma raiz própria, instalada apenas na loja de certificados do
Windows; o Node recusa essa cadeia e a cota do Claude para de atualizar.

Quando a recusa é exatamente essa (emissor desconhecido), o TokenBar repete a consulta uma
vez aceitando também as raízes da loja do Windows, a mesma confiança que o navegador já dá.
O que isso significa:

- Na tentativa recusada nada é enviado: o handshake falha antes de o token sair.
- Na segunda tentativa o token passa pelo inspetor local, como já passa o tráfego do
  navegador nessa máquina. Quem consegue instalar uma raiz na loja do Windows já tem acesso
  ao perfil e, portanto, ao `~/.claude/.credentials.json`.
- Um interceptador de rede sem raiz instalada na máquina continua recusado.
- Fica visível: o snapshot marca `tlsTrust: "system"` e a origem
  `Claude Code OAuth · certificados do Windows`; o diagnóstico registra o mesmo campo.
- Se nem a loja do Windows reconhecer o emissor, a falha aparece como `certificado` no
  painel (`failureKind: "tls"`), sem nova tentativa até o próximo ciclo.

Para não depender disso, exclua `api.anthropic.com` (ou o `node.exe`) da verificação de
conexões criptografadas do antivírus.

### O que fica em disco

`%LOCALAPPDATA%\tokenbar\snapshot.json` contém apenas: percentuais de uso, horários de
renovação, rótulos de janela, nome do plano (ex.: `max`), mensagens de diagnóstico e o
código técnico da última falha (ex.: `HTTP_503`, `SELF_SIGNED_CERT_IN_CHAIN`). É
gravado com as permissões padrão do perfil do usuário — ou seja, legível por processos que
já rodam com a sua conta. Trate o nome do plano como a informação mais sensível ali.

O diagnóstico local usa `diagnostics.jsonl` e `diagnostics.previous.jsonl`, cada um com
até 256 KiB, em `%LOCALAPPDATA%\tokenbar\`. Uma lista explícita de campos limita
o conteúdo a estado, categoria e código técnico da falha, duração e horários. O código só
aceita maiúsculas, dígitos e sublinhado, então texto remoto não cabe nele. Headers, corpos de resposta,
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
| Dependências de runtime | Nenhuma. O daemon é um bundle sem `node_modules` em produção. |
| Execução de processo | `codex app-server --stdio` e `agy --print /usage --print-timeout 10s`, encontrados em diretórios de instalação ou PATH. Argumentos fixos, nunca dados remotos; Antigravity usa executável nativo sem shell, timeout de 12 s e limite de saída de 64 KiB. |
| Resposta dos provedores | Percentuais passam por `clampPercent` (0–100); textos remotos são reduzidos ou trocados por mensagens locais; JSON inválido vira mensagem de erro, não exceção. |
| Script da bandeja | PowerShell local que **só lê** o snapshot e desenha o texto com GDI+ (sem HTML); não faz rede nem lê credenciais. |

## Boas práticas para quem instala

- Instale a partir do código-fonte, compilando o daemon você mesmo.
- Se sua sessão do Claude Code for comprometida, revogue-a no provedor — o TokenBar não
  guarda cópia do token, então basta refazer o login.
- Em máquina compartilhada, lembre que `%LOCALAPPDATA%\tokenbar\snapshot.json` fica legível
  para o seu próprio usuário; apague o arquivo se não quiser deixar o histórico de plano.
