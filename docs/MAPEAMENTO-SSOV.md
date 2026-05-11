# Mapeamento do projeto — SSOV (Sistema de Soltura Operacional de Veículos)

Documento vivo: alinha **produto** e **implementação** no repositório. Atualizado para refletir stack e perfis reais.

## 1. Visão geral

O SSOV centraliza a frota num **mapa operacional** (Leaflet), com painel lateral de decisão (drawer), módulos de quebras por conta da manutenção, preventivas, recolhimento, histórico, KPIs e configurações. Não é um ERP nem um dashboard administrativo pesado.

## 2. Stack técnica (real no código)

| Camada | Tecnologia |
|--------|------------|
| Frontend | HTML, CSS, JavaScript ([`templates/dashboard.html`](../templates/dashboard.html), [`static/js/dashboard.js`](../static/js/dashboard.js), [`static/css/dashboard.css`](../static/css/dashboard.css)) |
| Mapa | Leaflet + MarkerCluster (CDN) |
| Backend | Flask ([`app.py`](../app.py), [`routes/api.py`](../routes/api.py)) |
| Telemetria / tempo real | **MySQL** — conexão e colunas em [`config.py`](../config.py) (`MYSQL_*`, nomes de colunas configuráveis) |
| Dados operacionais locais | **SQLite** — [`services/manutencao_local.py`](../services/manutencao_local.py): usuários, preventivas, recolhimentos, O.S., tabela `acoes_operacionais` (auditoria de ações) |
| API | REST JSON sob prefixo `/api/` |

**Nota:** documentos mais antigos que citam apenas PostgreSQL estão **desatualizados** em relação a este repositório.

## 3. Controlo de acesso e perfis

A sessão guarda `perfil` em minúsculas ([`routes/auth_api.py`](../routes/auth_api.py)).

| Perfil (valor típico na BD) | Leitura (GET públicos do mapa/frota) | Escrita (POST/PUT em preventivas, recolhimento, O.S., ações) |
|-----------------------------|--------------------------------------|----------------------------------------------------------------|
| **admin** | Sim | Sim |
| **operador** | Sim | Sim |
| **gerente**, **diretor**, **visualizador** (ou outros) | Sim, onde a API não exige login | **Não** — `_guard_escrita()` exige `admin` ou `operador`; resposta `403` |

Ou seja: **só `admin` e `operador` alteram** dados operacionais locais; outros perfis podem existir na tabela `usuarios` para evolução futura, mas a política implementada hoje é binária para escrita.

### Auditoria

- Registos de ações relevantes são gravados via [`POST /api/acoes`](../routes/api.py) em `acoes_operacionais`.
- Consulta: [`GET /api/auditoria`](../routes/api.py) — **requer sessão autenticada** (qualquer perfil logado pode listar; ajuste fino por perfil pode ser evolução futura).
- Na interface: módulo **Configurações** — botão «Últimas ações (auditoria)» preenche a tabela abaixo (credenciais necessárias).

## 4. Módulos da interface

Resumo alinhado ao painel único:

- **Mapa:** frota, filtros, chips, atualização periódica.
- **Quebras por conta da manutenção:** tabela de localização com prioridade alta (categoria técnica `critico` / hash `#criticos` inalterados no código).
- **Preventivas / Recolhimento:** CRUD local SQLite + integração mapa.
- **Histórico:** histórico por prefixo (MySQL via serviço de veículos).
- **Operação:** KPIs que aplicam filtros e voltam ao mapa.
- **Configurações:** tema, export CSV, diagnóstico, login, auditoria resumida.

## 5. Governança e Git

Ver [AMD/README.md](AMD/README.md) — commits obrigatórios: [005-git-github-commits-obrigatorios.md](AMD/005-git-github-commits-obrigatorios.md).

## 6. Roadmap de refinamento (fases 3–4)

Consistência visual, UX, performance do mapa, responsividade e substituição gradual de `alert` por feedback inline — sempre em **incrementos**, sem redesenho da arquitetura (ver [002-regras-oficiais-e-governanca.md](AMD/002-regras-oficiais-e-governanca.md)).
