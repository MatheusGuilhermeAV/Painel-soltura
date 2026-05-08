# Manifesto de produto — SSOV (Eucatur)

## O que o SSOV deixou de ser

- Protótipo.
- Dashboard genérico.
- Painel improvisado.

## O que o SSOV é

**Plataforma operacional oficial da Eucatur** para decisão de soltura em tempo real, centrada no **mapa como ambiente operacional** — não como fundo decorativo.

## Duas camadas de identidade

### Camada 1 — Eucatur (institucional)

- Empresa, confiança, robustez, autoridade.
- Referência: **manual de marca** — vermelho, verde, preto, tipografia forte.
- **Não objetivo**: parecer site institucional de marketing.

### Camada 2 — Operação (SSOV)

- Tempo real, monitoramento, criticidade, decisão, tensão operacional, controle.
- O SSOV **cria** essa linguagem visual de **centro de controle urbano**: despacho + telemetria + frota + central tática.

## Conceito central

Transmitir continuamente:

> «Existe uma operação viva acontecendo agora.»

## Hierarquia de leitura (agressiva, com propósito)

1. Problema / criticidade  
2. Decisão (liberar / reter / ação)  
3. Estado atual (GPS, linha, O.S.)  
4. Contexto secundário e histórico  

**Densidade controlada**: operacional não é minimalismo vazio; cada elemento deve ser útil para decisão.

## Mapa soberano

- Overlays são **instrumentos**.
- Painéis são **consoles**.
- Estados devem ser **imediatamente reconhecíveis** (cor e rótulo, não animação chamativa nos veículos salvo decisão futura registrada em ADR).

## Modos futuros (direção)

- **Normal** — operação estável.
- **Crítico** — alta concentração de offline / recolhimento / críticos: intensidade visual global (não necessariamente animação em cada marcador).
- **Madrugada** — tema mais escuro, menos fadiga.

Implementação de modos exige ADR e atualização de tokens.

## Camadas de mapa (direção)

Operação | Críticos | Preventivas | Recolhimento | (futuro) calor operacional.

Cada camada altera o que o mapa enfatiza **sem** competir com a soberania do mapa como área principal.

## Ritmo operacional (direção)

- Indicador de «última atualização há Xs».
- Eventos discretos (toasts/fila) para mudanças relevantes.
- **Pulsos em marcadores**: somente se aprovado em ADR (hoje: **cor estática por estado**, ver [003](003-tokens-cor-e-estados.md)).

## Nome visual

Uso recomendado na interface:

- **SSOV** (sigla principal)  
- Subtítulo: **Centro Operacional** · **Eucatur**

Texto exato sujeito a alinhamento com comunicação corporativa.
