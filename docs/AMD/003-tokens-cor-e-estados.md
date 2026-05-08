# Tokens de cor e estados operacionais (oficial)

**Fonte de verdade técnica** em código:

- Cores CSS: `:root` em `static/css/dashboard.css` (prefixo `--euc-`, `--op-`).
- Cor API por veículo: `services/status.py` → `classify_vehicle_status()` (campo `mapa_cor` + `ssov_categoria`).

Qualquer divergência entre CSS e Python é **bug**; corrigir os dois ao mesmo tempo.

## Cores institucionais Eucatur (referência operacional)

> **Confirmar valores exatos no manual oficial de marca.**  
> Até lá, usar os hex abaixo como baseline aprovado em ADR implícito (substituir quando o manual fechar).

| Token | Hex | Uso |
|-------|-----|-----|
| `euc.vermelho` | `#E30613` | Crítico, alertas institucionais fortes |
| `euc.vermelho-profundo` | `#7A0B12` | Recolhimento (comprometimento operacional) |
| `euc.verde` | `#009639` | Disponível / estabilidade operacional |
| `euc.preto` | `#0A0A0A` | Base, texto, peso institucional (UI escura) |

## Cores camada operação (SSOV)

| Token | Hex | Estado `ssov_categoria` |
|-------|-----|-------------------------|
| Operação âmbar | `#D97706` | `atencao` |
| Operação azul | `#0369C5` | `preventiva_dia` |
| Sem GPS (cinza frio) | `#5F6B7A` | `sem_gps` |

## Política de marcadores no mapa (decisão vigente)

- **Apenas cor** (por categoria / estado), **sem** pulse, **sem** halo animado, **sem** glow piscante.
- Tamanho e borda podem diferenciar levemente crítico vs estável via CSS estático — **sem** animação até novo ADR.
- Cluster: indicador numérico operacional — sem efeitos que distraiam da leitura da frota.

## Estados × sensação × implementação atual

| Estado | Sensação | Marcador |
|--------|----------|----------|
| Disponível | Controle, estabilidade | Verde Eucatur, estático |
| Atenção | Monitorar | Âmbar, estático |
| Crítico | Ação necessária | Vermelho Eucatur, estático |
| Sem GPS | Perda de visibilidade | Cinza frio, «morto», estático |
| Recolhimento | Comprometido | Vermelho profundo, estático |
| Preventiva | Programado | Azul operacional, estático |

## Drawer / console

Estrutura lógica fixa (ver implementação em `dashboard.js`): alerta principal → identificação/classificação → decisão → contexto → histórico → comandos.

Mudança de ordem ou remoção de blocos: **ADR**.
