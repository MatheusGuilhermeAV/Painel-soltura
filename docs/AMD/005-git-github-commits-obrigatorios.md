# Git e GitHub — commits obrigatórios

## Regra absoluta

**Qualquer alteração no projeto** — criar, editar ou apagar ficheiros sob controlo de versão (`git`) — **deve ser registada num commit** antes de a tarefa ser dada por concluída.

Isto vale para **toda a gente** que mexa no repositório: operadores humanos, agentes (Cursor, CI, outros automatismos) e revisores que apliquem mudanças localmente.

**Não é aceitável** deixar o working tree com alterações por commitar ao terminar o trabalho, salvo pedido explícito do utilizador ou impossibilidade técnica documentada abaixo.

## Objetivo

Garantir **rastreabilidade**, **cópia de segurança no remoto** e **revisão humana** de qualquer mudança neste repositório.

## Obrigações antes de concluir

Quem alterar o projeto deve, **antes de concluir a tarefa ou a entrega ao utilizador**:

1. Rever o diff (`git status`, `git diff`).
2. Incluir as alterações relevantes no índice (`git add` com âmbito adequado; evitar `git add .` cego se houver artefactos que não devam ir para o histórico).
3. Registar um **`git commit`** com mensagem **clara, em português ou inglês**, em **frases completas**, descrevendo *o quê* e *porquê* (não mensagens vazias ou genéricas do tipo «fix» sem contexto).
4. Sempre que o remoto **GitHub** estiver configurado e as credenciais / permissões permitirem, executar **`git push`** para o branch em curso (em geral `origin` e o branch ativo).

## Âmbito

A regra aplica-se a **todas** as alterações versionadas: código, estilos, templates, documentação AMD, scripts, configuração e outros ficheiros rastreados pelo `git`, salvo as exceções abaixo.

## Push para o GitHub

- O **commit local** é **sempre** obrigatório quando houver mudanças a registar.
- O **`git push`** é obrigatório **sempre que for tecnicamente possível** (rede, `origin` apontando ao GitHub, autenticação válida). Assim o GitHub reflete o trabalho concluído e outras pessoas ou agentes podem sincronizar.

## Boas práticas de mensagem

- Uma linha de assunto até ~72 caracteres, seguida opcionalmente de corpo com detalhes.
- Referenciar documentos AMD ou tickets quando fizer sentido (ex.: «Ajusta tokens conforme 003»).

## Exceções (explícitas)

- O **utilizador pedir explicitamente** para não fazer commit ou para deixar alterações só no working tree.
- **Impossibilidade técnica** (sem remoto, falha de autenticação, política da organização que impeça push): neste caso quem alterou deve **completar o commit local** e **informar o utilizador** de que o push falhou e porquê, para ele executar o push manualmente.

## Relação com outras regras AMD

Esta regra **não substitui** [002-regras-oficiais-e-governanca.md](002-regras-oficiais-e-governanca.md) nem [004-areas-protegidas-sem-adr.md](004-areas-protegidas-sem-adr.md): mudanças em áreas protegidas continuam a exigir **ADR** antes do merge, independentemente do fluxo de commit.

## Resumo para copiar para regras de agente

> **Qualquer alteração no projeto exige commit.** Push para o GitHub quando possível. Mensagem descritiva. Nunca terminar com working tree sujo sem acordo do utilizador.
