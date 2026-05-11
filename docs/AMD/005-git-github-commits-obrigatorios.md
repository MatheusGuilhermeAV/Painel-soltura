# Git e GitHub — commits obrigatórios (agentes)

## Objetivo

Garantir **rastreabilidade**, **cópia de segurança no remoto** e **revisão humana** de qualquer mudança feita por agentes (Cursor, CI ou outro automatismo) neste repositório.

## Regra obrigatória

Todo **agente** que **alterar, criar ou apagar** ficheiros sob controlo de versão (`git`) neste projeto deve, **antes de concluir a tarefa ou a entrega ao utilizador**:

1. Rever o diff (`git status`, `git diff`).
2. Incluir as alterações relevantes no índice (`git add` com âmbito adequado; evitar `git add .` cego se houver artefactos que não devam ir para o histórico).
3. Registar um **`git commit`** com mensagem **clara, em português ou inglês**, em **frases completas**, descrevendo *o quê* e *porquê* (não mensagens vazias ou genéricas do tipo «fix» sem contexto).
4. Sempre que o remoto **GitHub** estiver configurado e as credenciais / permissões permitirem, executar **`git push`** para o branch em curso (em geral `origin` e o branch ativo).

Isto aplica-se a **todas** as alterações de código, estilos, templates, documentação AMD, scripts e configurações versionadas, salvo as exceções abaixo.

## Push para o GitHub

- O **commit local** é **sempre** obrigatório quando houver mudanças a registar.
- O **`git push`** é obrigatório **sempre que for tecnicamente possível** (rede, `origin` apontando ao GitHub, autenticação válida). Assim o GitHub reflete o trabalho concluído e outras pessoas ou agentes podem sincronizar.

## Boas práticas de mensagem

- Uma linha de assunto até ~72 caracteres, seguida opcionalmente de corpo com detalhes.
- Referenciar documentos AMD ou tickets quando fizer sentido (ex.: «Ajusta tokens conforme 003»).

## Exceções (explícitas)

- O **utilizador pedir explicitamente** para não fazer commit ou para deixar alterações só no working tree.
- **Impossibilidade técnica** (sem remoto, falha de autenticação, política da organização que impeça push): neste caso o agente deve **completar o commit local** e **informar o utilizador** de que o push falhou e porquê, para ele executar o push manualmente.

## Relação com outras regras AMD

Esta regra **não substitui** [002-regras-oficiais-e-governanca.md](002-regras-oficiais-e-governanca.md) nem [004-areas-protegidas-sem-adr.md](004-areas-protegidas-sem-adr.md): mudanças em áreas protegidas continuam a exigir **ADR** antes do merge, independentemente do fluxo de commit.

## Resumo para copiar para regras de agente

> Após qualquer alteração versionada: **commit obrigatório**; **push para o GitHub** quando possível; mensagem descritiva; nunca terminar com working tree sujo sem acordo do utilizador.
