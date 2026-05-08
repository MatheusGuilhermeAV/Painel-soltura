# Áreas protegidas — não alterar sem ADR

Esta lista existe para evitar edições **acidentais** que quebrem produto ou identidade.  
**ADR obrigatório** antes do merge se a mudança afetar o comportamento ou o contrato descrito aqui.

## Princípios (qualquer arquivo)

1. Quebrar a **soberania do mapa** como área principal.  
2. Remover ou inverter a **hierarquia**: criticidade/decisão antes de ruído administrativo.  
3. Alterar **estados operacionais** ou **cores oficiais** sem atualizar [003-tokens-cor-e-estados.md](003-tokens-cor-e-estados.md) e código espelho.  
4. Introduzir **animações chamativas** em marcadores de frota sem ADR ([003 política atual](003-tokens-cor-e-estados.md)).  
5. Tratar SSOV como **site institucional** em vez de **centro operacional**.

## Arquivos / módulos sensíveis

| Área | Arquivos típicos | Por quê |
|------|-------------------|---------|
| Classificação e cor da frota | `services/status.py` (`classify_vehicle_status`, `compute_status`) | KPIs, mapa, decisão |
| Enriquecimento frota | `services/veiculos.py` (merge contexto SSOV, KPIs) | Consistência operacional |
| Contrato HTTP | `routes/api.py` (prefixos `/api/frota`, `/api/localizacao`, auth em mutações) | Integrações e segurança |
| Identidade UI e tokens | `static/css/dashboard.css` (`:root` Eucatur/SSOV, drawer, marcadores) | Marca + leitura |
| Console e mapa | `static/js/dashboard.js` (clusters, filtros, drawer, barra viva) | Fluxo operador |
| Shell SSOV | `templates/dashboard.html` (topo discreto, drawer, barras, ordem menu) | Estrutura fixa |

## Documentação AMD

Os arquivos em `docs/AMD/**` só devem ser **removidos** ou **neutralizados** com ADR que explique o substituto.

## Exceções

- Correções de bug que **restauram** o comportamento documentado nos AMDs → não exigem ADR novo, apenas referência ao doc violado no PR.
