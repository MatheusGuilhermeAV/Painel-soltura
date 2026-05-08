# Plano técnico — Painel de soltura da manutenção

**Produto:** sistema web de apoio à decisão operacional na soltura de veículos da manutenção.  
**Versão do documento:** 1.2.1 · **Data:** 2026-04-17  
**Pilares obrigatórios:** dados confiáveis, regra de negócio clara, status compreensível, interface objetiva, tratamento de falha/incompletude, validação com a operação real.

---

## 1. Identificação e propósito

### 1.1 Problema operacional (o que o sistema deve resolver)

No dia a dia da soltura, a manutenção e a operação precisam responder com rapidez e segurança a perguntas como:

- O veículo está na rua ou na garagem?
- Está em operação ou parado?
- Qual é a linha atual ou a última linha registrada?
- Quem é o último motorista vinculado (quando houver dado)?
- Há indício de viagem em andamento ou de veículo ainda operando?
- Há comunicação recente com o rastreador (última atualização)?
- O veículo pode ser **liberado**, deve ser **avaliado** ou **não liberado** neste momento?

**Resultado esperado desta etapa (fechado):** o sistema deve permitir identificar, em tempo quase real, a localização do veículo, a linha atual ou última linha, a última atualização de posição, camadas de status (comunicação, posição, operação, soltura), o último motorista quando existir fonte para isso, e a recomendação de soltura (**pode liberar** / **avaliar** / **não liberar**), com **motivo auditável** quando a classificação for inferida ou parcial.

### 1.2 O que este sistema **não** é

Não é um “site de mapa” ou painel de curiosidade. É um **sistema de apoio à decisão** com rastreabilidade da origem dos dados e honestidade sobre lacunas.

### 1.3 Usuários e contexto de uso (a validar com a gestão)

| Perfil        | Uso típico                                      | Ações esperadas (futuro)     |
|---------------|-------------------------------------------------|------------------------------|
| Manutenção    | Decidir soltura, priorizar recolhimento         | Leitura; futuro: bloqueios   |
| Tráfego / CCO | Contexto operacional, substituição            | Leitura                      |
| Encarregado   | Visão consolidada, exceções                     | Leitura                      |

**Contexto de acesso:** a confirmar (monitor na oficina, desktop administrativo, celular). O MVP deve ser **responsivo** e legível em tela grande; mobile como evolução.

---

## 2. Escopo

### 2.1 Dentro do escopo (MVP → evolução)

| Fase   | Conteúdo                                                                 |
|--------|---------------------------------------------------------------------------|
| MVP 1  | Frota consolidada, mapa, busca por prefixo, detalhe, histórico recente   |
| MVP 2  | Painel de soltura com regras acordadas, filtros, indicadores              |
| MVP 3  | Alertas, relatórios, perfis, bloqueio/liberação manual, auditoria       |

### 2.2 Fora do escopo (inicial)

- Substituição de sistemas oficiais da empresa (Sonda, ERP, etc.).
- Decisão automática sem supervisão humana (a recomendação é **apoio**; a responsabilidade operacional permanece com o processo interno).

---

## 3. Fontes de dados

### 3.1 Princípio arquitetural

- **Navegador:** consome **apenas** a API interna do Flask.
- **Backend:** único ponto que fala com MySQL e com a API Sonda; normaliza, faz merge, calcula status, expõe contrato estável.

### 3.2 Fonte A — MySQL (`soltura_tempo_real` / `viagenspercursobusdor`)

**Papel:** base rápida de **posição e histórico** já disponível na infraestrutura atual.

**Colunas conhecidas (confirmar em produção com `DESCRIBE`):**

| Coluna         | Uso no sistema                          |
|----------------|-----------------------------------------|
| `id`           | Chave técnica do registro (histórico)   |
| `vehicle_code` | **Chave de integração** (= prefixo)     |
| `date`         | Data/hora da posição (ordenar, stale)   |
| `latitude`     | Posição                                 |
| `longitude`    | Posição                                 |
| `linha`        | Linha atual / última                   |
| `sentido`      | Sentido                                 |

**Limitações atuais (assumidas até prova em contrário):** sem motorista, viagem, ignição, velocidade nesta tabela — **complemento via API Sonda** ou outras fontes quando existirem.

### 3.3 Fonte B — API Sonda

**Papel:** complemento **operacional** (motorista, viagem, telemetria, status de equipamento, etc.), quando disponível.

**Implementação no repositório:** `services/sonda_api.py` (HTTP GET, `urllib`), mapeamento de campos via variáveis `SONDA_FIELD_*` e `SONDA_RESPONSE_ROOT_KEY` no `.env`. **A matriz abaixo ainda deve ser preenchida com os nomes reais** retornados pela API de vocês.

### 3.4 Matriz de rastreabilidade (evoluir junto com o levantamento)

| Conceito no sistema   | MySQL (`viagenspercursobusdor`) | API Sonda | Observação                        |
|-----------------------|---------------------------------|-----------|-----------------------------------|
| Identificador veículo | `vehicle_code`                  | A confirmar | Deve ser a mesma chave lógica  |
| Última atualização    | `date`                          | A confirmar | Definir timezone (UTC vs local)   |
| Posição               | `latitude`, `longitude`         | A confirmar | Validar nulos e coordenadas zero  |
| Linha / sentido       | `linha`, `sentido`              | A confirmar |                                   |
| Motorista / matrícula | Não                           | A confirmar |                                   |
| Viagem / status       | Não                           | A confirmar |                                   |
| Velocidade / ignição  | Não                           | A confirmar |                                   |

**Regra de ouro:** cada release atualiza esta tabela com “existe?”, “nome real do campo”, “exemplo”, “confiável?”.

### 3.5 Precedência de merge

O backend expõe `tempo.fonte_principal_frota` em `GET /api/frota`: **`sonda`** ou **`mysql`**.

**Modo Sonda principal** (automático quando a Sonda está configurada, o GET de frota em lote retornou HTTP OK e a lista normalizada tem pelo menos um veículo): GPS, horário, linha e sentido exibidos vêm da Sonda quando há latitude/longitude válidas; MySQL completa **placa** e serve de **fallback** de posição se o veículo não tiver coordenadas no lote; divergências linha/sentido continuam gerando `flags.divergencia_*`. Telemetria (motorista, viagem, velocidade, ignição) segue a regra “Sonda quando informado, senão MySQL”.

**Modo MySQL principal** (Sonda desligada, erro de rede/HTTP no lote ou lote vazio): mescla **v1.1** — posição e linha/sentido na UI pelo MySQL; Sonda apenas complementa telemetria e comparação.

| Dado | Modo MySQL principal | Modo Sonda principal |
|------|----------------------|----------------------|
| Lat/lon/hora | MySQL | Sonda (fallback MySQL se sem coordenadas no lote) |
| Linha/sentido na UI | MySQL | Sonda quando preenchidos; senão MySQL |
| Telemetria / motorista / viagem | Sonda quando existir | Sonda quando existir; senão MySQL |
| Regras de soltura | `services/status.py` | Idem |

Detalhe por veículo: se `SONDA_VEHICLE_PATH_TEMPLATE` estiver definido, a consulta unitária tem prioridade sobre o registro em lote **para aquele prefixo**; se a frota em lote falhar mas a unitária responder, o merge daquele veículo **não** marca `sonda_indisponivel` para os campos obtidos na unitária (e o detalhe pode ainda operar em modo Sonda principal se a unitária existir).

### 3.6 Modelo de preenchimento da matriz Sonda (copiar para o plano ou wiki)

| Campo interno | Endpoint/rota | Método | Auth | Parâmetro | Nome real no JSON | Exemplo | Frequência | Confiança |
|-----------------|----------------|--------|------|-----------|-------------------|---------|------------|-------------|
| `prefixo` | *(preencher)* | GET | Bearer | — | *(preencher)* | `08217` | *(preencher)* | Alta |
| `motorista` | | | | | | | | |
| … | | | | | | | | |

### 3.7 Procedimento de calibração da Sonda (amostra → `.env`)

**Fluxo acordado**

1. Extrair da Sonda a árvore de chaves e **um item** anonimizado, preservando **nomes reais de chaves** e **tipos** (string, número, boolean, objeto, array).
2. Ajustar no `.env`: `SONDA_RESPONSE_ROOT_KEY`, `SONDA_FIELD_*`, `SONDA_TRIP_ACTIVE_VALUES` (e rotas `SONDA_FLEET_PATH` / opcional `SONDA_VEHICLE_PATH_TEMPLATE`).
3. Rodar os **6 casos reais** de validação (merge completo, ausência na Sonda, divergência linha/sentido, `trip_status` ativo, GPS desatualizado, etc.).
4. Substituir a lógica provisória pela **regra oficial** da manutenção em `services/status.py`.

**Formato sugerido para colar a amostra** (exemplo ilustrativo; trocar pelas chaves reais da API):

```json
{
  "root_preview": {
    "data": {
      "items": [
        {
          "bus_code": "00000",
          "driver_name": "ANON",
          "driver_id": "0000",
          "trip_id": "TRIP-000",
          "trip_status": "OPEN",
          "speed": 0,
          "ignition": true,
          "line": "000",
          "direction": "IDA",
          "timestamp": "2026-04-17T12:00:00"
        }
      ]
    }
  }
}
```

O envelope `root_preview` é opcional: pode enviar o JSON **igual** ao da API. Se a lista estiver mais aninhada, basta manter o caminho até o array e um elemento representativo.

---

## 4. Arquitetura lógica

### 4.1 Fluxo de dados (oficial)

1. Flask obtém conjunto base de veículos/posições a partir do **MySQL** (último registro por `vehicle_code`).
2. Flask solicita dados complementares na **API Sonda** (por lote ou por veículo, conforme limite da API).
3. **Merge** no backend por `vehicle_code` → objeto interno único.
4. Cálculo ordenado das **camadas de status** + `motivo_soltura` / flags de confiabilidade.
5. Resposta JSON **única** para o front.

### 4.2 Decisões arquiteturais (oficiais até revisão)

| Decisão              | Escolha                                              |
|----------------------|------------------------------------------------------|
| Fonte base de posição| MySQL (último `date` por `vehicle_code`)             |
| Fonte complementar   | API Sonda                                            |
| Chave de integração  | `vehicle_code` (exposto ao front como `prefixo`)   |
| Merge                | Sempre no **backend**                                |
| Cache                | Leve (ex.: TTL por endpoint); dimensionar após carga |

### 4.3 Casos de merge (obrigatórios)

| Caso | Comportamento esperado |
|------|-------------------------|
| 1 — Existe no MySQL e no Sonda | Objeto completo; observação vazia ou informativa |
| 2 — Existe no MySQL, não no Sonda | Posição + linha do MySQL; flags “sem Sonda”; não inventar telemetria |
| 3 — Existe no Sonda, não no MySQL | Com `tempo.fonte_principal_frota=sonda`, o veículo aparece na frota (placa pode ficar vazia até existir linha MySQL) |

---

## 5. Contrato interno de dados (JSON para o front)

Nomes estáveis consumidos pela interface. Origem (MySQL/Sonda/ inferido) pode ser exposta em campo técnico opcional para auditoria.

```json
{
  "prefixo": "08123",
  "placa": null,
  "latitude": -3.102,
  "longitude": -60.012,
  "linha": "652",
  "sentido": "CENTRO",
  "ultima_atualizacao": "2026-04-17T14:10:00",
  "motorista": null,
  "matricula_motorista": null,
  "viagem_id": null,
  "viagem_status": "NAO_INFORMADO",
  "velocidade": null,
  "ignicao": null,
  "status_comunicacao": "ATUALIZADO",
  "status_posicao": "FORA_GARAGEM",
  "status_operacional": "EM_ANALISE",
  "status_soltura": "AVALIAR",
  "motivo_soltura": "Classificação parcial: sem dados de viagem na fonte atual.",
  "flags": {
    "dados_incompletos": true,
    "sem_dados_motorista": true,
    "sem_dados_viagem": true,
    "gps_desatualizado": false,
    "classificacao_inferida": true
  }
}
```

**Nota de implementação (v1.2):** `GET /api/frota` inclui `tempo.assume_timezone_naive_mysql`, `tempo.fonte_principal_frota` (valores `sonda` ou `mysql`) e `tempo.consulta_servidor_utc`. `GET /api/frota` e `GET /api/veiculo/<prefixo>` expõem `ultima_atualizacao`, camadas de status, `motivo_soltura` (texto curto operacional), `flags` com vocabulário padronizado, `fontes` e divergências Sonda. `hora_posicao` permanece como alias legado. O bloco `sonda` resume a última consulta em lote. Evolução do contrato até versão **2.0** do payload deve manter agrupamento lógico (exibição / operação / confiabilidade / diagnóstico).

---

## 6. Regras de negócio — camadas de status

### 6.1 Separação obrigatória (não misturar em um único campo)

1. **Status de comunicação** — atraso desde `ultima_atualizacao` (atualizado / atraso leve / sem atualização).
2. **Status de posição** — coordenada válida? dentro da cerca da garagem?
3. **Status operacional** — linha, viagem, movimento/parada, contexto (quando houver dados).
4. **Status de soltura** — **pode liberar** / **avaliar** / **não liberar** + **motivo**.

### 6.2 Tabela de decisão (rascunho — **substituir após workshop com a manutenção**)

| Condição (exemplo) | Status de soltura |
|--------------------|-------------------|
| Indício forte de viagem ativa ou operação fora da garagem | Não liberar |
| Fora da garagem + linha preenchida + atualização recente | Não liberar (validar) |
| Sem atualização > limiar acordado | Avaliar ou não liberar (definir) |
| Na garagem + sem viagem ativa + comunicação OK | Pode liberar (validar) |
| Posição inválida ou dados insuficientes | Avaliar |

**Limiares numéricos:** parametrizados em `.env` (ex.: atenção 20 min, crítico 60 min) e **validados** com a operação.

### 6.3 Garagem

**MVP:** círculo (`GARAGE_LAT`, `GARAGE_LON`, `GARAGE_RADIUS_METERS`).  
**Evolução:** polígono (múltiplos pátios), múltiplas cercas.

### 6.4 Timezone da coluna `date` (v1.2)

- Variável `DATA_EVENT_TIMEZONE` no `.env` (padrão deste projeto: `America/Manaus` — operação em Manaus/AM).
- Valores **naive** retornados pelo MySQL são interpretados nesse fuso e convertidos internamente para comparação com o relógio UTC do servidor (`services/schema.py` → `parse_datetime`).
- Se o banco já gravar em UTC, defina `DATA_EVENT_TIMEZONE=UTC` (ou equivalente).
- O endpoint `GET /api/frota` devolve `tempo.assume_timezone_naive_mysql` para transparência ao front.
- Em Windows, o pacote **`tzdata`** (listado em `requirements.txt`) garante que `ZoneInfo` resolva fusos como `America/Manaus` corretamente.

---

## 7. API interna (painel)

Base URL sugerida: `/api`.

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/health` | Saúde (MySQL ping, latência, flag Sonda configurada) |
| GET | `/api/frota` | Frota + merge Sonda + `sonda` + `tempo` (fuso assumido para `date` naive) |
| GET | `/api/veiculo/<prefixo>` | Detalhe do veículo (último estado) |
| GET | `/api/veiculo/<prefixo>/historico` | Histórico recente (mais recente primeiro) |
| GET | `/api/meta/colunas` | Colunas da tabela (diagnóstico) |
| GET | `/api/meta/tabela` | Nome da tabela + contagem de registros |

**Regras:** respostas com `ok`, mensagens de erro claras; nunca expor stack trace ao cliente em produção.

---

## 8. Integração Sonda (checklist técnico)

- [x] Cliente HTTP com timeout, Bearer ou API key, SSL configurável (`SONDA_VERIFY_SSL`).
- [x] Frota em lote + opcional GET por veículo (`SONDA_VEHICLE_PATH_TEMPLATE`).
- [x] Normalização configurável (`SONDA_FIELD_*`, `SONDA_RESPONSE_ROOT_KEY`).
- [ ] Autenticação avançada (OAuth com renovação) se for o caso da Sonda.
- [ ] Ambiente (homologação vs produção) e restrições de IP/VPN documentados.
- [ ] Rate limit e retries com backoff após medir carga real.
- [ ] Matriz campo a campo **preenchida com resposta real** (nomes JSON definitivos).
- [ ] Teste bruto (curl/Postman) com 3–4 `vehicle_code` reais arquivado (sem dados sensíveis).

Concentração do código em `services/sonda_api.py` e merge em `services/fleet_merge.py` + `services/veiculos.py`; o front não consome formatos crus da Sonda.

---

## 9. Confiabilidade e transparência

O sistema deve preferir declarar **incerteza** a simular certeza.

**Vocabulário oficial de `flags` (v1.2 — valor `true` indica condição ativa):**

| Flag | Significado |
|------|-------------|
| `sonda_nao_configurada` | `SONDA_FLEET_PATH` / base não configurados |
| `sonda_indisponivel` | Erro HTTP/rede ao consultar frota Sonda |
| `sonda_sem_registro_frota` | Sonda OK, mas veículo ausente no lote |
| `sonda_sem_coordenadas_frota` | Registro Sonda sem lat/lon utilizáveis |
| `posicao_fallback_mysql` | Modo Sonda principal, mas posição veio do MySQL neste veículo |
| `sonda_sem_horario_gps` | Coordenadas da Sonda sem timestamp; horário mantido do MySQL |
| `divergencia_linha` | Linha MySQL ≠ linha normalizada Sonda |
| `divergencia_sentido` | Sentido MySQL ≠ sentido Sonda |
| `sem_dados_motorista` | Sem nome de motorista após merge |
| `sem_dados_viagem` | Sem viagem/id e sem `trip_status` útil |
| `dados_incompletos` | Motorista e viagem ausentes simultaneamente |
| `gps_desatualizado` | Atraso ≥ limiar de atenção na última posição |
| `sem_posicao_valida` | Latitude/longitude inválidas ou ausentes |
| `classificacao_inferida` | Decisão baseada em heurística até regra oficial |

**Campo textual:** `motivo_soltura` — mensagem **curta**, operacional, auditável (produto; não só log técnico). `observacao` mantém detalhe complementar da regra atual.

---

## 10. Validação e testes

### 10.1 Testes técnicos

- Endpoints respondem; tratamento de veículo inexistente; nulos em lat/long; linha/sentido vazios; datas antigas; timezone.
- Performance da query de “último por veículo” com volume real.

### 10.2 Testes lógicos

- Cada linha da tabela de decisão (após fechada com a manutenção) tem casos de teste nomeados.

### 10.3 Testes operacionais

- Amostra de veículos em situações conhecidas; pergunta: “o que a manutenção esperava ver?” vs “o que o sistema mostrou?”.

---

## 11. Produção interna (checklist)

- [ ] `.env` fora do repositório; rotação de credenciais se expostas.
- [ ] Logs de erro e de integração (sem gravar segredos).
- [ ] Timeouts e limites de pool de conexões MySQL.
- [ ] Cache com TTL após perfilar carga.
- [ ] Serviço em rede local / VM; firewall; acesso apenas à rede operacional.
- [ ] HTTPS interno se aplicável.

---

## 12. Fases de implementação (ordem de execução)

| Etapa | Entrega | Validação |
|-------|---------|-----------|
| 1 | Documento de objetivo + usuários + decisão apoiada | Aprovação verbal/escrita do gestor |
| 2 | Matriz de fontes e campos (MySQL + Sonda) | Tabela preenchida com nomes reais |
| 3 | Contrato JSON interno versionado | Front consome só esse contrato |
| 4 | Workshop de regras com manutenção | Tabela de decisão assinada |
| 5 | Cerca da garagem definida | Teste com pontos conhecidos |
| 6 | Camada MySQL fechada (timezone, índices, limites) | Testes da seção 10.1 |
| 7 | Cliente Sonda + testes brutos | Respostas reais arquivadas (sem dados sensíveis) |
| 8 | Merge + flags + motivo | Casos 1–3 cobertos |
| 9 | Recalibração das quatro camadas de status | Testes 10.2 e 10.3 |
| 10 | API interna completa + versionamento leve | Contrato estável |
| 11 | Refino de UI (KPIs, filtros, densidade de informação) | Usuário piloto |
| 12 | Produção interna + observabilidade | Checklist seção 11 |

---

## 13. Melhorias futuras (pós-MVP estável)

Alertas automáticos, exportação, múltiplas garagens, histórico em mapa, trilha de decisão de soltura, perfis e permissões, integração com sistema de oficina, bloqueio/liberação manual auditável.

---

## 14. Referência no repositório

- Configuração: `config.py`, `.env.example`
- Persistência: `services/db_tempo_real.py`
- Normalização MySQL: `services/schema.py`
- API Sonda (HTTP + normalização): `services/sonda_api.py`
- Merge e precedência: `services/fleet_merge.py`
- Montagem da frota / contrato da API: `services/veiculos.py`
- Regras de status (a recalibrar após workshop): `services/status.py`

Este documento é o **mapa oficial** do projeto até nova versão (incrementar `Versão do documento` no topo a cada revisão material).
