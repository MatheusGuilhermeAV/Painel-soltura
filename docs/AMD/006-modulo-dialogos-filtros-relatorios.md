# Diálogos de módulo para filtros e relatórios

## Status

Aceito (2026-05-11).

## Contexto

A aba **Quebras** passou a concentrar lançamentos e exportações em **caixas de diálogo** (`<dialog>`), com campos pesquisáveis (combobox) alimentados pelos dados já existentes no SSOV. Formulários e filtros **espalhados no painel do módulo** poluem a leitura operacional e dificultam reutilizar o mesmo padrão em novas abas.

## Decisão

1. **Filtros e relatórios novos** em módulos do SSOV (ações que pedem parâmetros ao operador ou confirmam exportação) **não** ficam em linhas `form-inline` no corpo do módulo.
2. O módulo expõe **apenas botões de ação** (ex.: «Lançar quebra», «Exportar geral (CSV)», «Relatório específico…») numa **toolbar de módulo** (`.op-module-toolbar`), antes das tabelas ou blocos de leitura. Cada ação abre um **diálogo modal** nativo.
3. **Toolbar de módulo:** `role="toolbar"` no contentor; grupos `.op-module-toolbar__group` com `btn-toolbar`; grupo secundário (ex.: relatórios) em `.op-module-toolbar__group--end` com rótulo `.op-module-toolbar__label`; consultas simples podem usar `.op-module-toolbar__input` no mesmo grupo. Filtros locais de tabela ficam em `.op-module-table-toolbar`; títulos de secção usam `op-console-block__label` + `.op-module-section-label`.
4. **Shell visual obrigatório:** classes `op-module-dialog` + `op-quebra-dialog` (estrutura `__header`, `__body`, `__footer`, `__hint`), botões **Cancelar** e ação primária, fecho por **×**, **Cancelar**, clique no fundo ou **Escape** (comportamento nativo do `<dialog>`).
5. **Campos com catálogo** (prefixo, linha, motorista, motivo, etc.) usam **combobox** (`.op-combo`): o operador **digita para procurar**; o valor **só é confirmado** ao **clicar na opção** ou **Enter**; campo oculto `.op-combo__value` é o que segue para `FormData` / query string.
6. **Relatório geral** (sem filtros): diálogo de **confirmação** com texto explicativo antes de gerar o ficheiro.
7. **Relatório específico** (com filtros): diálogo com todos os parâmetros; exportação só após **Gerar CSV** no rodapé.
8. **Implementação de referência:** aba Quebras (toolbar + diálogos), Configurações e Histórico (toolbar) em `templates/dashboard.html`, `static/js/dashboard.js` (`wireModuleDialog`, `wireComboBox`, `openDlgQuebra`, `openDlgQuebrasRelatorio`, `openDlgQuebrasRelatorioGeral`) e `static/css/dashboard.css`.

## Consequências

- **Positivas:** painéis de módulo mais limpos; padrão único para futuras abas; combobox reutilizável; alinhamento com o console do drawer (ação concentrada, sem ruído).
- **Trade-offs:** mais um clique para abrir o diálogo; lógica de UI concentrada em `dashboard.js` até extrair componente partilhado se o volume crescer.

## Identidade e mapa

- [x] Respeita [002-regras-oficiais-e-governanca.md](002-regras-oficiais-e-governanca.md) (mapa soberano; formulários não competem com o mapa).
- [x] Mapa permanece área principal; diálogos são sobreposição modal, não substituem o mapa.
- [ ] Tokens de cor inalterados ([003-tokens-cor-e-estados.md](003-tokens-cor-e-estados.md) não exige atualização para este AMD).

## Governança

- Novos filtros ou exportações **fora** deste padrão exigem **ADR** ou revisão deste AMD.
- Alterar a **referência Quebras** (remover diálogos, voltar filtros inline) exige ADR e atualização deste documento.

## Referências

- Implementação: `templates/dashboard.html`, `static/js/dashboard.js`, `static/css/dashboard.css`
- API exportação quebras: `GET /api/export/quebras.csv` em `routes/api.py`
