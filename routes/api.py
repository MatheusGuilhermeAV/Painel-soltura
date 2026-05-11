import time
from csv import DictWriter
from datetime import datetime, timezone
from io import StringIO

from flask import Response, jsonify, request, session

from config import Config
from routes import bp_api
from routes.auth_api import require_login, require_operador
from services import db_tempo_real, sonda_api, veiculos
from services import manutencao_local


def _guard_escrita():
    err = require_login()
    if err:
        return err
    return require_operador()


def _usuario_op() -> str | None:
    return session.get("login")


@bp_api.after_request
def _api_no_store(response):
    """Evita cache de GET no navegador/proxy — cada clique/atualização lê o MySQL de novo."""
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@bp_api.route("/health")
def api_health():
    mysql = {"ok": False, "latencia_ms": None, "erro": None}
    t0 = time.perf_counter()
    try:
        conn = db_tempo_real.get_connection()
        try:
            conn.ping(reconnect=False)
        finally:
            conn.close()
        mysql["ok"] = True
        mysql["latencia_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    except Exception as e:
        mysql["erro"] = str(e)
    sonda = sonda_api.is_configured()
    return jsonify(
        {
            "ok": True,
            "servicos": {"mysql": mysql},
            "sonda_configurada": sonda,
        }
    )


@bp_api.route("/veiculo/<prefixo>")
def api_veiculo(prefixo: str):
    try:
        v = veiculos.get_vehicle_detail(prefixo)
        if not v:
            return jsonify({"ok": False, "erro": "Veículo não encontrado", "veiculo": None}), 200
        return jsonify({"ok": True, "veiculo": v})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e), "veiculo": None}), 200


@bp_api.route("/veiculos")
def api_veiculos():
    """Alias conceitual para frota operacional."""
    return api_frota()


@bp_api.route("/frota")
def api_frota():
    tz = (getattr(Config, "DATA_EVENT_TIMEZONE", None) or "").strip() or "UTC"
    try:
        bundle = veiculos.list_fleet_bundle()
        return jsonify({"ok": True, **bundle})
    except Exception as e:
        now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        return jsonify(
            {
                "ok": False,
                "erro": str(e),
                "veiculos": [],
                "sonda": {
                    "configurada": sonda_api.is_configured(),
                    "erro": None,
                    "http_status": None,
                    "registros_normalizados": 0,
                },
                "tempo": {
                    "assume_timezone_naive_mysql": tz,
                    "consulta_servidor_utc": now,
                    "fonte_principal_frota": "mysql",
                    "diagnostico_frota": "Erro ao montar a frota — veja o campo erro na resposta JSON.",
                },
            }
        ), 200


@bp_api.route("/localizacao")
def api_localizacao():
    try:
        data = veiculos.list_carros_para_localizar()
        return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e), "veiculos": []}), 200


@bp_api.route("/kpis")
def api_kpis():
    try:
        data = veiculos.get_kpis_operacionais()
        return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e), "kpis": {}}), 200


@bp_api.route("/veiculo/<prefixo>/historico")
def api_historico(prefixo: str):
    limite = request.args.get("limite", default="50")
    try:
        n = max(1, min(200, int(limite)))
    except ValueError:
        n = 50
    try:
        data = veiculos.get_vehicle_history(prefixo, limit=n)
        return jsonify({"ok": True, "prefixo": prefixo, "historico": data})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e), "prefixo": prefixo, "historico": []}), 200


@bp_api.route("/schema")
def api_schema():
    """Metadados de tabela + colunas (alias nomeado no documento SSOV)."""
    try:
        cols = db_tempo_real.list_table_columns()
        n = db_tempo_real.count_rows()
        return jsonify(
            {
                "ok": True,
                "database": Config.MYSQL_DATABASE,
                "tabela": Config.MYSQL_TABLE,
                "colunas": cols,
                "total_registros": n,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500


@bp_api.route("/meta/colunas")
def api_colunas():
    try:
        cols = db_tempo_real.list_table_columns()
        return jsonify({"ok": True, "colunas": cols})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500


@bp_api.route("/meta/tabela")
def api_meta_tabela():
    try:
        n = db_tempo_real.count_rows()
        return jsonify(
            {
                "ok": True,
                "database": Config.MYSQL_DATABASE,
                "tabela": Config.MYSQL_TABLE,
                "total_registros": n,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500


@bp_api.route("/meta/ultima_linha_tabela")
def api_meta_ultima_linha_tabela():
    """Saúde da carga: MAX(date), atraso global, volume e veículos com ponto hoje."""
    try:
        h = db_tempo_real.fetch_table_health()
        return jsonify({"ok": True, "database": Config.MYSQL_DATABASE, **h})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 200


@bp_api.route("/os", methods=["GET", "POST"])
def api_os():
    if request.method == "GET":
        try:
            prefixo = request.args.get("prefixo")
            situacao = request.args.get("situacao")
            rows = manutencao_local.list_os(prefixo=prefixo, situacao=situacao)
            return jsonify({"ok": True, "itens": rows})
        except Exception as e:
            return jsonify({"ok": False, "erro": str(e), "itens": []}), 200
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        payload = request.get_json(silent=True) or {}
        item = manutencao_local.create_os(payload)
        return jsonify({"ok": True, "item": item}), 201
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/os/<int:os_id>", methods=["PATCH"])
def api_os_patch(os_id: int):
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        payload = request.get_json(silent=True) or {}
        item = manutencao_local.update_os(os_id, payload)
        if not item:
            return jsonify({"ok": False, "erro": "O.S não encontrada"}), 404
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/preventivas", methods=["GET", "POST"])
def api_preventivas():
    if request.method == "GET":
        try:
            prefixo = request.args.get("prefixo")
            rows = manutencao_local.list_preventivas(prefixo=prefixo)
            return jsonify({"ok": True, "itens": rows})
        except Exception as e:
            return jsonify({"ok": False, "erro": str(e), "itens": []}), 200
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        payload = request.get_json(silent=True) or {}
        item = manutencao_local.upsert_preventiva(payload)
        return jsonify({"ok": True, "item": item}), 201
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/preventivas/agenda", methods=["GET", "POST"])
def api_preventivas_agenda():
    if request.method == "GET":
        try:
            rows = manutencao_local.list_preventivas_agenda(
                prefixo=request.args.get("prefixo"),
                data=request.args.get("data"),
                status=request.args.get("status"),
            )
            return jsonify({"ok": True, "itens": rows})
        except Exception as e:
            return jsonify({"ok": False, "erro": str(e), "itens": []}), 200
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        item = manutencao_local.create_preventiva_agenda(request.get_json(silent=True) or {}, usuario=_usuario_op())
        return jsonify({"ok": True, "item": item}), 201
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/preventivas/agenda/<int:agenda_id>/baixa", methods=["PUT"])
def api_preventivas_baixa(agenda_id: int):
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        item = manutencao_local.baixa_preventiva_agenda(agenda_id, usuario=_usuario_op())
        if not item:
            return jsonify({"ok": False, "erro": "Registro não encontrado ou já finalizado"}), 404
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/preventivas/agenda/<int:agenda_id>/cancelar", methods=["PUT"])
def api_preventivas_cancelar(agenda_id: int):
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        item = manutencao_local.cancelar_preventiva_agenda(agenda_id, usuario=_usuario_op())
        if not item:
            return jsonify({"ok": False, "erro": "Registro não encontrado ou já finalizado"}), 404
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/recolhimentos", methods=["GET", "POST"])
def api_recolhimentos():
    if request.method == "GET":
        try:
            rows = manutencao_local.list_recolhimentos(
                prefixo=request.args.get("prefixo"),
                status=request.args.get("status"),
            )
            return jsonify({"ok": True, "itens": rows})
        except Exception as e:
            return jsonify({"ok": False, "erro": str(e), "itens": []}), 200
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        item = manutencao_local.create_recolhimento(request.get_json(silent=True) or {}, usuario=_usuario_op())
        return jsonify({"ok": True, "item": item}), 201
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/recolhimentos/<int:rec_id>/status", methods=["PUT"])
def api_recolhimentos_status(rec_id: int):
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        st = (request.get_json(silent=True) or {}).get("status")
        item = manutencao_local.update_recolhimento_status(rec_id, str(st or ""), usuario=_usuario_op())
        if not item:
            return jsonify({"ok": False, "erro": "Recolhimento não encontrado"}), 404
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/acoes", methods=["POST"])
def api_acoes():
    guard = _guard_escrita()
    if guard:
        return guard
    try:
        p = request.get_json(silent=True) or {}
        item = manutencao_local.registrar_acao(
            str(p.get("prefixo") or ""),
            str(p.get("tipo_acao") or "acao"),
            p.get("descricao"),
            _usuario_op(),
        )
        return jsonify({"ok": True, "item": item}), 201
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/liberacao-mecanica", methods=["POST"])
def api_liberacao_mecanica():
    """Registo explícito da manutenção: liberado / retido para soltura, ou volta ao automático."""
    guard = _guard_escrita()
    if guard:
        return guard
    payload = request.get_json(silent=True) or {}
    prefixo = str(payload.get("prefixo") or "").strip()
    estado = str(payload.get("estado") or "").strip().lower()
    obs = str(payload.get("observacao") or "").strip() or None
    if not prefixo:
        return jsonify({"ok": False, "erro": "prefixo é obrigatório"}), 400
    if estado not in ("liberado", "retido", "auto"):
        return jsonify({"ok": False, "erro": "estado inválido (use liberado, retido ou auto)"}), 400
    usuario = _usuario_op()
    try:
        if estado == "auto":
            manutencao_local.delete_liberacao_mecanica(prefixo)
            manutencao_local.registrar_acao(
                prefixo,
                "liberacao_mecanica",
                "Volta ao automático (painel).",
                usuario,
            )
            return jsonify({"ok": True, "item": None}), 200
        row = manutencao_local.upsert_liberacao_mecanica(prefixo, estado, usuario, observacao=obs)
        manutencao_local.registrar_acao(
            prefixo,
            "liberacao_mecanica",
            f"Estado: {estado}" + (f" — {obs}" if obs else ""),
            usuario,
        )
        return jsonify({"ok": True, "item": row}), 200
    except ValueError as e:
        return jsonify({"ok": False, "erro": str(e)}), 400


@bp_api.route("/auditoria")
def api_auditoria():
    """Lista últimas ações operacionais — requer sessão (qualquer perfil autenticado)."""
    err = require_login()
    if err:
        return err
    try:
        limite = request.args.get("limite", "200")
        n = max(1, min(500, int(limite)))
    except ValueError:
        n = 200
    try:
        rows = manutencao_local.list_acoes(limit=n)
        return jsonify({"ok": True, "itens": rows})
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e), "itens": []}), 200


@bp_api.route("/export/localizacao.csv")
def api_export_localizacao_csv():
    try:
        data = veiculos.list_carros_para_localizar()
        items = data.get("veiculos") or []
        cols = [
            "prefixo",
            "prioridade_localizacao",
            "acao_localizacao",
            "motivo_localizacao",
            "status_operacional",
            "status_manutencao",
            "linha",
            "sentido",
            "hora_posicao",
            "minutos_sem_atualizacao",
            "na_garagem",
            "em_viagem_inferido",
        ]
        buff = StringIO()
        wr = DictWriter(buff, fieldnames=cols)
        wr.writeheader()
        for x in items:
            wr.writerow({c: x.get(c) for c in cols})
        csv_txt = buff.getvalue()
        return Response(
            csv_txt,
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="carros_para_localizar.csv"'},
        )
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500


@bp_api.route("/export/frota.csv")
def api_export_frota_csv():
    try:
        data = veiculos.list_fleet_bundle()
        items = data.get("veiculos") or []
        cols = [
            "prefixo",
            "linha",
            "sentido",
            "status_operacional",
            "status_soltura",
            "status_comunicacao",
            "status_posicao",
            "hora_posicao",
            "minutos_sem_atualizacao",
            "na_garagem",
            "em_viagem_inferido",
            "prioridade_localizacao",
            "acao_localizacao",
            "motivo_localizacao",
            "status_manutencao",
        ]
        buff = StringIO()
        wr = DictWriter(buff, fieldnames=cols)
        wr.writeheader()
        for x in items:
            wr.writerow({c: x.get(c) for c in cols})
        csv_txt = buff.getvalue()
        return Response(
            csv_txt,
            mimetype="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="frota_completa.csv"'},
        )
    except Exception as e:
        return jsonify({"ok": False, "erro": str(e)}), 500
