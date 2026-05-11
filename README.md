# Painel Soltura / SSOV (Eucatur)

Repositório oficial no GitHub: **[github.com/MatheusGuilhermeAV/Painel-soltura](https://github.com/MatheusGuilhermeAV/Painel-soltura)**  
Clone: `https://github.com/MatheusGuilhermeAV/Painel-soltura.git`

## Executar localmente

1. Python 3.10+ recomendado.  
2. `pip install -r requirements.txt`  
3. Configurar variáveis (ver `.env.example`).  
4. `python app.py` — painel em [http://127.0.0.1:5000](http://127.0.0.1:5000) (ver `app.py`).

Teste de fumo local: `python scripts/smoke_ssov.py` (import da app + `/api/health`).

No Windows PowerShell, use `Set-Location` para a pasta do projeto antes de `python app.py`.

## Documentação de produto (AMD)

Decisões e governança: [docs/AMD/README.md](docs/AMD/README.md).

Mapeamento técnico (stack, perfis, módulos): [docs/MAPEAMENTO-SSOV.md](docs/MAPEAMENTO-SSOV.md).
