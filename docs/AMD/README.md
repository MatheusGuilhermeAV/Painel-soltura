# AMD — Architecture / Decisões do SSOV (Eucatur)

Esta pasta registra **decisões permanentes** do **SSOV — Sistema de Soltura Operacional de Veículos**, plataforma operacional oficial da **Eucatur**.

## O que é AMD aqui

- **Registro do que foi decidido** e **por quê**.
- **O que não pode ser alterado** sem um novo registro (ver [004-areas-protegidas-sem-adr.md](004-areas-protegidas-sem-adr.md)).
- **Tokens institucionais** e **estados operacionais** (ver [003-tokens-cor-e-estados.md](003-tokens-cor-e-estados.md)).

## Como mudar algo sensível

1. Leia [002-regras-oficiais-e-governanca.md](002-regras-oficiais-e-governanca.md) e [005-git-github-commits-obrigatorios.md](005-git-github-commits-obrigatorios.md) (**qualquer alteração no projeto exige commit**; push quando possível).
2. Se o arquivo estiver na lista **protegida**, abra um **ADR** novo: copie `000-template.md` para `ADR-YYYY-MM-<slug>.md`, preencha e referencie no PR.
3. Atualize o documento de tokens ou estados se a mudança afetar cor, classificação ou identidade.

## Mapeamento do produto (stack e perfis)

- [MAPEAMENTO-SSOV.md](../MAPEAMENTO-SSOV.md) — visão geral, **MySQL + SQLite**, perfis e auditoria alinhados ao código.

## Índice

| Doc | Conteúdo |
|-----|----------|
| [000-template.md](000-template.md) | Modelo de ADR |
| [001-manifesto-produto-ssov.md](001-manifesto-produto-ssov.md) | Identidade em duas camadas, direção visual, ritmo |
| [002-regras-oficiais-e-governanca.md](002-regras-oficiais-e-governanca.md) | Regras 1–8 + processo de mudança |
| [003-tokens-cor-e-estados.md](003-tokens-cor-e-estados.md) | Cores Eucatur / operação e estados no mapa |
| [004-areas-protegidas-sem-adr.md](004-areas-protegidas-sem-adr.md) | Arquivos e princípios **não editar sem ADR** |
| [005-git-github-commits-obrigatorios.md](005-git-github-commits-obrigatorios.md) | **Qualquer alteração no projeto:** commit obrigatório; push GitHub quando possível |
| [006-modulo-dialogos-filtros-relatorios.md](006-modulo-dialogos-filtros-relatorios.md) | Diálogos modais e combobox para filtros/relatórios em módulos |
| [007-ambiente-local-mysql-env.md](007-ambiente-local-mysql-env.md) | MySQL tempo real no ambiente local: `.env`, credenciais fora do Git, verificação do mapa |

## Nome visual sugerido (oficial)

**SSOV — Centro Operacional** · Operações Eucatur (uso em interface: ver `templates/dashboard.html`).

Confirmar formulação final com comunicação institucional.
