"""Fumo: importa a app Flask e valida health, quebras e integração operacional."""
from __future__ import annotations

import os
import sys
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _login_admin(client) -> bool:
    from config import Config

    pw = str(getattr(Config, "SSOV_DEFAULT_ADMIN_PASSWORD", None) or "admin").strip()
    r = client.post("/api/auth/login", json={"login": "admin", "senha": pw})
    if r.status_code != 200:
        print("FAIL: login status", r.status_code, file=sys.stderr)
        return False
    data = r.get_json(silent=True) or {}
    if not data.get("ok"):
        print("FAIL: login body", data, file=sys.stderr)
        return False
    return True


def main() -> int:
    from app import create_app
    from services import manutencao_local
    from services.status import classify_vehicle_status
    from services.veiculos import _avaliar_localizacao

    app = create_app()
    client = app.test_client()
    r = client.get("/api/health")
    if r.status_code != 200:
        print("FAIL: /api/health status", r.status_code, file=sys.stderr)
        return 1
    data = r.get_json(silent=True) or {}
    if not data.get("ok"):
        print("FAIL: /api/health body ok=false", data, file=sys.stderr)
        return 1
    print("OK: create_app + /api/health")

    prefixo = f"SMOKE-Q-{int(time.time())}"
    quebra = manutencao_local.create_quebra(
        {
            "prefixo": prefixo,
            "linha": "676",
            "motorista": "Motorista teste",
            "motivo": "Falha mecânica",
            "descricao": "Registo de fumo automatizado",
        },
        usuario="smoke",
    )
    if str(quebra.get("status") or "").lower() != "ativa":
        print("FAIL: quebra criada sem status ativa", quebra, file=sys.stderr)
        return 1
    os_id = int(quebra.get("os_id") or 0)
    if not os_id:
        print("FAIL: quebra sem os_id", quebra, file=sys.stderr)
        return 1

    listed = manutencao_local.list_quebras(prefixo=prefixo, status="ativa", motivo="mecânica")
    if not listed or int(listed[0]["id"]) != int(quebra["id"]):
        print("FAIL: list_quebras filtro motivo", listed, file=sys.stderr)
        return 1

    ctx = manutencao_local.contexto_ssov_por_prefixos([prefixo]).get(prefixo) or {}
    if not ctx.get("quebra_ativa"):
        print("FAIL: contexto sem quebra_ativa", ctx, file=sys.stderr)
        return 1

    veiculo = {
        "status_comunicacao": "ONLINE",
        "latitude": -3.1,
        "longitude": -60.0,
        "na_garagem": True,
        "em_viagem_inferido": False,
        "minutos_sem_atualizacao": 5,
    }
    loc = _avaliar_localizacao(veiculo, ctx, base_critica=False)
    if str(loc.get("prioridade_localizacao") or "").lower() != "alta":
        print("FAIL: prioridade_localizacao", loc, file=sys.stderr)
        return 1
    merged = {**veiculo, **loc, "os_abertas": ctx.get("os_abertas") or []}
    cat, _cor = classify_vehicle_status(merged)
    if cat != "critico":
        print("FAIL: ssov_categoria esperado critico, obteve", cat, file=sys.stderr)
        return 1

    if not _login_admin(client):
        return 1
    r_post = client.post(
        "/api/quebras",
        json={
            "prefixo": prefixo,
            "linha": "1",
            "motorista": "X",
            "motivo": "dup",
            "descricao": "não deve duplicar",
        },
    )
    if r_post.status_code != 400:
        print("FAIL: duplicata de quebra deveria retornar 400", r_post.status_code, file=sys.stderr)
        return 1

    r_csv = client.get(f"/api/export/quebras.csv?prefixo={prefixo}&motivo=mecânica")
    if r_csv.status_code != 200 or "text/csv" not in str(r_csv.mimetype or ""):
        print("FAIL: export quebras.csv", r_csv.status_code, r_csv.mimetype, file=sys.stderr)
        return 1
    if prefixo not in (r_csv.get_data(as_text=True) or ""):
        print("FAIL: CSV sem prefixo", file=sys.stderr)
        return 1

    manutencao_local.update_os(os_id, {"situacao": "finalizada"})
    encerradas = manutencao_local.list_quebras(prefixo=prefixo, status="encerrada")
    if not encerradas:
        print("FAIL: quebra não encerrada após O.S.", file=sys.stderr)
        return 1

    print("OK: quebras + mapa critico + export + encerramento O.S.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
