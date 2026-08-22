# Como contribuir

Obrigado pelo interesse. O TokenBar é pequeno de propósito — a melhor contribuição costuma
ser a menor que resolve o problema.

## Antes de escrever código

- **Bug?** Abra uma issue com: versão do TokenBar, sistema operacional, provedor afetado
  (Claude/Codex) e a mensagem exata que aparece no painel.
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

`F5` no VS Code abre uma janela de desenvolvimento com a extensão carregada.

Para a bandeja:

```powershell
npm run compile-daemon
wscript tray\tokenbar.vbs       # o próprio script sobe o daemon
```

O `tokenbar.ps1` inicia `dist\daemon.js` sozinho e o encerra ao sair — não suba o daemon
à mão junto com o indicador, ou você terá dois processos coletando. Para depurar só o
coletor, rode `node dist\daemon.js 60` **sem** abrir a bandeja.

`tray\tokenbar.ps1 -PreviewPath saida.png` renderiza o painel num PNG sem abrir GUI — use
isso para revisar mudanças de layout sem precisar de screenshot.

## Estilo de código

O projeto não tem linter configurado; siga o que já está lá:

- TypeScript `strict`, 2 espaços de indentação, aspas simples, ponto e vírgula.
- Modificadores explícitos (`public`, `private`, `readonly`) em membros de classe.
- Nomes de variáveis e mensagens de usuário em **português**; nomes de tipos, interfaces e
  campos de API em inglês.
- Nada de dependências de runtime novas. Se precisar de uma, justifique na issue — a
  ausência delas é uma decisão de segurança, não um acaso.
- Comentários só onde o "porquê" não é óbvio pelo código.

## Regras específicas dos coletores

Essas não são preferência estética; quebrá-las quebra o comportamento do app:

1. **`usedPercent` é sempre o percentual usado**, 0–100, passando por `clampPercent()`.
   A conversão para "restante" é responsabilidade da camada de interface.
2. **Não remova o piso de 5 minutos nem o backoff de 429** do coletor Claude. Eles evitam
   martelar um endpoint não documentado.
3. **Pré-requisito ausente é `unavailable`, não `error`.** Use o helper `unavailable()`.
   `error` fica para falha inesperada.
4. **Todo texto vindo de um provedor passa por `escapeHtml()`** antes de entrar no HTML do
   painel.
5. **Nenhum token pode entrar em snapshot, log, `globalState` ou mensagem de erro.**

## Testes

`src/test/test.ts` é uma suíte sem framework: asserções diretas, saída com código 1 se algo
falhar. Adicione casos ali para qualquer lógica pura que você tocar (rotulagem de janelas,
normalização de percentual, formatação de duração).

Rode `npm test` antes de abrir o PR. O CI roda o mesmo comando.

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
