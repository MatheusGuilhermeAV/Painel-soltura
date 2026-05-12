# Ambiente local — MySQL tempo real e `.env`

## Contexto

O mapa e a frota no SSOV dependem de dados de viagens em tempo real. A fonte principal, quando a API Sonda não está configurada, é o **MySQL** da base `soltura_tempo_real`, tabela `viagenspercursobusdor`. Sem credenciais válidas no ambiente local, `/api/frota` e `/api/localizacao` devolvem `ok: false` e lista vazia — o mapa carrega os tiles, mas **não há marcadores**.

## Decisão

1. **Credenciais e segredos** ficam apenas no ficheiro **`.env` na raiz do repositório**, nunca no GitHub nem em commits.
2. O modelo versionado é **`.env.example`**: copiar para `.env` e preencher localmente.
3. O `.env` está no **`.gitignore`**; alterações nele **não entram** no histórico remoto.
4. A leitura das variáveis é feita em `config.py` (`load_dotenv`); o acesso à base usa `services/db_tempo_real.py` e a montagem da frota, `services/veiculos.py` (`list_fleet_bundle`).

## Parâmetros MySQL (tempo real)

| Variável | Valor de referência (rede interna) | Notas |
|----------|-----------------------------------|--------|
| `MYSQL_HOST` | `192.168.138.12` | VPN/rede até ao servidor |
| `MYSQL_PORT` | `3306` | Padrão MySQL |
| `MYSQL_USER` | `MANUTENCAO` | Conta fornecida pela equipa de base de dados |
| `MYSQL_PASSWORD` | *(preencher no `.env` local)* | **Nunca** commitar |
| `MYSQL_DATABASE` | `soltura_tempo_real` | |
| `MYSQL_TABLE` | `viagenspercursobusdor` | |

Os nomes das colunas (`COL_PREFIXO`, `COL_LAT`, `COL_LON`, etc.) seguem o `.env.example` e devem ser confirmados com `DESCRIBE` em produção se a tabela mudar.

### Senha com caracteres especiais

Se a senha contiver `#`, `$` ou outros símbolos, usar **aspas simples** no `.env` para o `#` não ser interpretado como início de comentário. Exemplo de formato (valor fictício):

```env
MYSQL_PASSWORD='sua_senha_aqui'
```

## Procedimento local

1. Copiar `.env.example` para `.env` (se ainda não existir).
2. Preencher `MYSQL_PASSWORD` e rever host, utilizador, base e tabela.
3. Garantir ligação à rede/VPN até `MYSQL_HOST`.
4. Iniciar **uma** instância do painel: `python app.py` (evitar vários `app.py` em paralelo — processos antigos podem servir respostas sem a senha carregada).
5. Abrir `http://127.0.0.1:5000` e atualizar o browser.

## Verificação rápida

- `GET /api/health` → `servicos.mysql.ok: true`.
- `GET /api/frota` → `ok: true` e `veiculos` com `latitude` / `longitude` preenchidos.
- No topo do painel: **API: Online**; no mapa, marcadores após o primeiro encaixe da vista.

Em linha de comando (sem expor a senha no terminal):

```text
python -c "from services.db_tempo_real import get_connection; c=get_connection(); c.ping(); print('mysql_ok')"
```

## Fonte alternativa (Sonda)

Com `SONDA_API_BASE` e `SONDA_FLEET_PATH` preenchidos e resposta HTTP válida, a frota pode usar a Sonda como fonte principal (`tempo.fonte_principal_frota` na API). Enquanto a Sonda estiver desativada, o MySQL local é **obrigatório** para testes de mapa e KPIs de frota.

## Segurança e governança

- Pedir credenciais por canal interno aprovado; não colar senhas em issues, PRs, AMD ou chat versionado.
- Se uma senha tiver sido exposta fora do `.env` local, solicitar **rotação** à equipa de base de dados.
- Documentação AMD e `.env.example` descrevem **nomes** de variáveis e hosts de referência, não segredos.

## Relação com outras regras

- Commits obrigatórios para alterações versionadas: [005-git-github-commits-obrigatorios.md](005-git-github-commits-obrigatorios.md). O `.env` **não** é versionado.
- Visão de stack e perfis: [MAPEAMENTO-SSOV.md](../MAPEAMENTO-SSOV.md).
