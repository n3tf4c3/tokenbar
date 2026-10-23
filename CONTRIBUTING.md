# Como contribuir

Obrigado pelo interesse. O TokenBar é pequeno de propósito — a melhor contribuição costuma
ser a menor que resolve o problema.

## Antes de escrever código

- **Bug?** Abra uma issue com: versão do TokenBar, sistema operacional, provedor afetado
  (Claude/Codex/Antigravity) e a mensagem exata que aparece no painel da bandeja.
- **Falha de segurança?** Não abra issue. Siga [SECURITY.md](SECURITY.md).
- **Funcionalidade nova?** Abra uma issue antes do PR. Um provedor novo ou uma mudança de
  interface vale discutir primeiro; correção de bug pode ir direto para o PR.

Leia [docs/arquitetura.md](docs/arquitetura.md) antes de mexer nos coletores.

## Ambiente

```powershell
npm install
npm run compile
npm test
```

Para a bandeja:

```powershell
npm run compile
Start-Process conhost -WindowStyle Hidden -ArgumentList '--headless','powershell','-NoProfile','-ExecutionPolicy','RemoteSigned','-WindowStyle','Hidden','-File','tray\tokenbar.ps1'   # sem janela; o próprio script sobe o daemon
```

O `tokenbar.ps1` inicia `dist\daemon.js` sozinho e o encerra ao sair — não suba o daemon
à mão junto com o indicador, ou você terá dois processos coletando. Para depurar só o
coletor, rode `node dist\daemon.js 60` **sem** abrir a bandeja.

## Capturas da documentação

A imagem do `README.md` (`docs/imagens/bandeja-windows.png`) é gerada pelo próprio projeto,
não por screenshot manual — se você mudar o layout, regenere-a no mesmo PR:

```powershell
tray\tokenbar.ps1 -PreviewPath docs\imagens\bandeja-windows.png
```

Renderiza o painel e o ícone num PNG sem abrir a GUI. Use também para revisar mudanças de
layout durante o desenvolvimento.

## Estilo de código

O projeto não tem linter configurado; siga o que já está lá:

- TypeScript `strict`, 2 espaços de indentação, aspas simples, ponto e vírgula.
- Modificadores explícitos (`public`, `private`, `readonly`) em membros de classe.
- Nomes de variáveis e mensagens de usuário em **português**; nomes de tipos, interfaces e
  campos de API em inglês.
- Nada de dependências de runtime novas. Se precisar de uma, justifique na issue — a
  ausência delas é uma decisão de segurança, não um acaso.
- `@types/node` fica **preso de propósito** numa versão antiga, para o typecheck não aceitar
  API recente de Node. O `npm outdated` sempre vai reclamar dele; não bumpe sem decidir
  também o Node mínimo do daemon.
  Tipos à frente do runtime fazem o typecheck aceitar API que não existe em produção.
- Comentários só onde o "porquê" não é óbvio pelo código.

## Regras específicas dos coletores

Essas não são preferência estética; quebrá-las quebra o comportamento do app:

1. **`usedPercent` é sempre o percentual usado**, 0–100, passando por `clampPercent()`.
   Se a fonte retorna cota restante (Antigravity), converta uma vez no coletor. Nenhuma
   camada de apresentação inverte o sinal: ícone, tooltip e painel da bandeja mostram esse
   número direto, para bater com o `/usage` do Claude Code. As faixas de cor (70% âmbar, 90%
   vermelho) ficam em `Get-Tone`, em `tray/tokenbar.ps1`.
2. **Não remova o piso de 5 minutos nem o backoff de 429** do coletor Claude. Eles evitam
   martelar um endpoint não documentado.
3. **Pré-requisito ausente é `unavailable`, não `error`.** Use o helper `unavailable()`.
   `error` fica para falha inesperada.
4. **Nenhum token pode entrar em snapshot, log ou mensagem de erro.**
5. **Antigravity só executa o `/usage` do CLI oficial**, com argumentos fixos, prazo e
   limite de saída. Preserve o piso de 60 segundos e a espera de 5 minutos após `429`;
   não leia credenciais do Google nem crie um proxy de autenticação.

## Testes

`src/test/test.ts` é uma suíte sem framework: asserções diretas, saída com código 1 se algo
falhar. Adicione casos ali para qualquer lógica pura que você tocar (rotulagem de janelas,
normalização de percentual, formatação de duração).

Rode `npm test` e `npm run test:tray` antes de abrir o PR. O CI executa as duas suítes no
Windows.

`src/test/regressions.ts` cobre falhas, cancelamento, recuperação, persistência de 429 e
validação. Os testes usam credenciais sintéticas e HTTP em loopback, sem consultar contas
reais. `src/test/tray.test.ps1` importa `tray/state.ps1` sem iniciar a GUI nem o daemon.
`src/test/antigravity.ts` cobre o TSV, conversão restante/usado, grupos, cache, reinício,
limitação de consultas, erros sanitizados e isolamento do novo provedor, sem executar o CLI real.
`src/test/codexSpark.ts` cobre a seleção e deduplicação dos limites Codex/Spark, respostas
legadas, contas sem Spark, validação, recuperação, persistência e o protocolo do app-server,
com respostas sintéticas e processo falso.

Para conferir a apresentação de cenários sintéticos:
`tray\tokenbar.ps1 -PreviewPath saida.png -SnapshotFile exemplo.json`.

## Pull requests

- Uma mudança lógica por PR.
- Descreva **o que muda e por quê**; se for correção, diga como reproduzir o bug antes.
- Se a mudança afeta o comportamento visível, atualize o `README.md` no mesmo PR.
- Se a mudança afeta o contrato entre módulos, atualize `docs/arquitetura.md`.
- Acrescente uma linha em `CHANGELOG.md`, na seção `## [Não publicado]`.
- Commits em português, no imperativo: `corrige backoff do Claude após 429`.

## Licença

Ao contribuir, você concorda que sua contribuição seja licenciada sob a
[MIT](LICENSE), como o resto do projeto.
