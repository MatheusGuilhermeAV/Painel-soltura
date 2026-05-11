from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Sequence

from config import Config
from services import db_tempo_real
from services.manutencao_local import contexto_ssov_por_prefixos
from services.fleet_merge import (
    build_motivo_soltura,
    merge_mysql_with_sonda,
    merge_sonda_with_mysql_fallback,
)
from services.schema import ColumnMap, row_to_vehicle_raw, serialize_datetime_for_api
from services.sonda_api import fetch_fleet_snapshot, fetch_vehicle_by_prefixo, is_configured
from services.status import classify_vehicle_status, compute_status


def _em_viagem_linha_identificada(merged: dict[str, Any]) -> bool:
    s_linha = str(merged.get("linha") or "").strip()
    return bool(s_linha and s_linha not in ("0", "-", "—", "N/A"))


def _serialize_value(v: Any) -> Any:
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    return v


def _sonda_meta(res: Any) -> dict[str, Any]:
    return {
        "configurada": is_configured(),
        "erro": getattr(res, "error", None),
        "http_status": getattr(res, "http_status", None),
        "registros_normalizados": len(getattr(res, "by_vehicle_code", {}) or {}),
        "itens_objeto_na_lista": int(getattr(res, "raw_item_count", 0) or 0),
        "descartados_sem_codigo_veiculo": int(getattr(res, "discarded_sem_codigo", 0) or 0),
    }


def _diagnostico_fonte_frota(
    *,
    use_sonda_primary: bool,
    configured: bool,
    http_err: str | None,
    n_veiculos_sonda: int,
    raw_items: int,
    discarded: int,
) -> str:
    """Texto curto para operador: por que a frota está em MySQL ou em Sonda."""
    if use_sonda_primary:
        return "Frota em tempo real: posição/linha priorizam a API Sonda (MySQL para placa e fallback)."
    if not configured:
        return (
            "Dados de GPS/linha vêm só do MySQL — a Sonda não está configurada "
            "(preencha SONDA_API_BASE e SONDA_FLEET_PATH no .env). Sem isso, horários antigos na base continuam iguais a cada atualização."
        )
    if http_err:
        return (
            "Dados de GPS/linha vêm só do MySQL — a chamada à Sonda falhou: "
            + str(http_err)
            + " Corrija URL/token ou rede; até lá o painel só repete o último registro gravado no banco."
        )
    if raw_items == 0:
        return (
            "Dados de GPS/linha vêm só do MySQL — a Sonda respondeu sem lista de veículos "
            "(verifique SONDA_RESPONSE_ROOT_KEY: deve apontar para o array de objetos no JSON)."
        )
    if n_veiculos_sonda == 0:
        return (
            f"Dados de GPS/linha vêm só do MySQL — a Sonda devolveu {raw_items} objeto(s) na lista, "
            f"mas {discarded} sem código de veículo reconhecido. Ajuste SONDA_FIELD_VEHICLE_CODE (ou chaves bus_code/prefixo no JSON)."
        )
    return ""


def _envelope_after_merge(
    merged: dict[str, Any],
    flags: dict[str, bool],
    fontes: dict[str, str],
    extras: dict[str, Any],
) -> dict[str, Any]:
    """Monta o JSON do veículo a partir do dicionário já mesclado (fonte única da verdade para GPS/hora)."""
    st = compute_status(merged)

    try:
        float(merged.get("latitude"))
        float(merged.get("longitude"))
    except (TypeError, ValueError):
        flags["sem_posicao_valida"] = True

    if st.minutos_sem_atualizacao is not None and st.minutos_sem_atualizacao >= Config.STALE_ATTENTION_MINUTES:
        flags["gps_desatualizado"] = True

    if flags.get("sem_dados_motorista") and flags.get("sem_dados_viagem"):
        flags["dados_incompletos"] = True

    flags["classificacao_inferida"] = True

    motivo = build_motivo_soltura(st.soltura, st.observacao or st.motivo_soltura, flags)

    ultima = serialize_datetime_for_api(merged.get("hora_posicao")) or _serialize_value(
        merged.get("hora_posicao")
    )
    trip_st = merged.get("trip_status")
    viagem_status = "NAO_INFORMADO"
    if trip_st is not None and str(trip_st).strip() != "":
        viagem_status = str(trip_st).strip()

    return {
        "prefixo": merged.get("prefixo"),
        "placa": merged.get("placa"),
        "latitude": merged.get("latitude"),
        "longitude": merged.get("longitude"),
        "hora_posicao": ultima,
        "ultima_atualizacao": ultima,
        "linha": merged.get("linha"),
        "sentido": merged.get("sentido"),
        "linha_sonda": extras.get("linha_sonda"),
        "sentido_sonda": extras.get("sentido_sonda"),
        "motorista": merged.get("motorista"),
        "matricula_motorista": merged.get("matricula_motorista"),
        "viagem_id": merged.get("viagem"),
        "viagem_status": viagem_status,
        "velocidade": merged.get("velocidade"),
        "ignicao": merged.get("ignicao"),
        "trip_status": merged.get("trip_status"),
        "status_comunicacao": st.status_comunicacao,
        "status_posicao": st.status_posicao,
        "status_operacional": st.operacional,
        "status_soltura": st.soltura,
        "motivo_soltura": motivo,
        "mapa_cor": st.mapa_cor,
        "atencao": st.atencao,
        "na_garagem": st.na_garagem,
        "minutos_sem_atualizacao": st.minutos_sem_atualizacao,
        "em_viagem_inferido": st.em_viagem_inferido,
        "em_viagem_linha_identificada": _em_viagem_linha_identificada(merged),
        "observacao": st.observacao,
        "flags": flags,
        "fontes": fontes,
    }


def _prioridade_ordem(prioridade: str) -> int:
    p = str(prioridade or "").strip().lower()
    if p == "alta":
        return 3
    if p == "media":
        return 2
    return 1


def _avaliar_localizacao(
    veiculo: dict[str, Any],
    ctx: dict[str, Any],
    *,
    base_critica: bool,
) -> dict[str, Any]:
    os_abertas = list((ctx or {}).get("os_abertas") or [])
    preventiva = (ctx or {}).get("preventiva") or {}
    preventiva_situacao = str(preventiva.get("situacao") or "em_dia").lower()

    prioridade = "baixa"
    motivo = "Monitoramento de rotina."
    acao = "Aguardar"
    status_manutencao = "Disponível"

    na_garagem = veiculo.get("na_garagem")
    em_viagem = veiculo.get("em_viagem_inferido")
    mins = veiculo.get("minutos_sem_atualizacao")
    sem_gps = veiculo.get("status_comunicacao") == "SEM_ATUALIZACAO"

    if os_abertas:
        status_manutencao = "O.S aberta"
        os_top = os_abertas[0]
        if na_garagem is False:
            prioridade = "alta"
            motivo = "O.S aberta + fora da garagem."
            acao = "Recolher"
        elif em_viagem is True:
            prioridade = "alta"
            motivo = "O.S aberta + indício de operação."
            acao = "Localizar"
        else:
            prioridade = os_top.get("prioridade") or "media"
            motivo = "O.S aberta."
            acao = "Localizar"
    elif preventiva_situacao == "vencida":
        status_manutencao = "Preventiva vencida"
        if em_viagem is True or na_garagem is False:
            prioridade = "alta"
            motivo = "Preventiva vencida + em operação."
            acao = "Recolher"
        else:
            prioridade = "media"
            motivo = "Preventiva vencida na garagem."
            acao = "Programar preventiva"
    elif preventiva_situacao == "proxima":
        status_manutencao = "Preventiva próxima"
        prioridade = "baixa"
        motivo = "Preventiva próxima."
        acao = "Programar preventiva"

    if sem_gps:
        if _prioridade_ordem(prioridade) < _prioridade_ordem("media"):
            prioridade = "media"
            motivo = "Sem GPS recente."
            acao = "Verificar"
        elif not os_abertas:
            motivo = f"{motivo} Sem GPS recente."
            acao = "Verificar"
    elif isinstance(mins, (int, float)) and mins >= Config.LOCALIZACAO_STALE_MEDIA_MIN:
        if _prioridade_ordem(prioridade) < _prioridade_ordem("media"):
            prioridade = "media"
            motivo = f"GPS atrasado (~{int(mins)} min)."
            acao = "Localizar"

    if base_critica and _prioridade_ordem(prioridade) < _prioridade_ordem("alta"):
        prioridade = "media"
        motivo = f"{motivo} Dados desatualizados — confirmar antes de tomar decisão."
        acao = "Verificar"

    if acao not in {"Localizar", "Recolher", "Programar preventiva", "Acompanhar", "Verificar", "Aguardar"}:
        acao = "Verificar"

    return {
        "prioridade_localizacao": prioridade,
        "motivo_localizacao": motivo,
        "acao_localizacao": acao,
        "status_manutencao": status_manutencao,
        "os_abertas": os_abertas,
        "preventiva": preventiva or None,
        "preventiva_situacao": preventiva_situacao,
    }


def _inject_liberacao_do_ctx(v: dict[str, Any], ctx: dict[str, Any]) -> None:
    row = ctx.get("liberacao_mecanica")
    if isinstance(row, dict) and str(row.get("estado") or "").strip():
        v["liberacao_mecanica"] = row
    else:
        v["liberacao_mecanica"] = None


def _patch_textos_liberacao_mecanica(v: dict[str, Any]) -> None:
    lib = v.get("liberacao_mecanica")
    if not isinstance(lib, dict) or not str(lib.get("estado") or "").strip():
        return
    est = str(lib.get("estado") or "").strip().lower()
    who = str(lib.get("usuario") or "").strip()
    tag = f" [manutenção · {who}]" if who else " [manutenção]"
    if est == "liberado":
        if v.get("status_comunicacao") == "SEM_ATUALIZACAO":
            return
        v["status_soltura"] = "Pode liberar"
        base = (v.get("motivo_soltura") or "").strip()
        v["motivo_soltura"] = (base + " Liberado para circulação pela manutenção." + tag).strip()
    elif est == "retido":
        v["status_soltura"] = "Não liberar"
        base = (v.get("motivo_soltura") or "").strip()
        v["motivo_soltura"] = (base + " Retenção explícita pela manutenção." + tag).strip()


def _envelope_sonda_primary(
    mysql_raw: dict[str, Any] | None,
    sonda_rec: dict[str, Any] | None,
    *,
    sonda_http_error: str | None,
) -> dict[str, Any]:
    merged, flags, fontes, extras = merge_sonda_with_mysql_fallback(
        mysql_raw,
        sonda_rec,
        sonda_configured=is_configured(),
        sonda_http_error=sonda_http_error,
    )
    return _envelope_after_merge(merged, flags, fontes, extras)


def _envelope_from_mysql_row(
    mysql_row: dict[str, Any],
    sonda_by_code: dict[str, dict[str, Any]],
    sonda_res: Any,
    sonda_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    m = ColumnMap.from_config(Config)
    raw = row_to_vehicle_raw(mysql_row, m)
    code = str(raw.get("prefixo") or "").strip()
    sonda_rec: dict[str, Any] | None = None
    if getattr(sonda_res, "error", None):
        sonda_rec = None
    elif sonda_override is not None:
        sonda_rec = sonda_override
    else:
        sonda_rec = sonda_by_code.get(code)

    http_err: str | None = getattr(sonda_res, "error", None)
    if sonda_override is not None:
        http_err = None

    merged, flags, fontes, extras = merge_mysql_with_sonda(
        raw,
        sonda_rec,
        sonda_configured=is_configured(),
        sonda_http_error=http_err,
    )
    return _envelope_after_merge(merged, flags, fontes, extras)


def list_fleet_bundle() -> dict[str, Any]:
    m = ColumnMap.from_config(Config)
    rows: Sequence[dict[str, Any]] = db_tempo_real.fetch_latest_per_prefixo()
    sonda_res = fetch_fleet_snapshot()
    by = getattr(sonda_res, "by_vehicle_code", {}) or {}
    http_err: str | None = getattr(sonda_res, "error", None)

    use_sonda_primary = is_configured() and not http_err and len(by) > 0
    raw_items = int(getattr(sonda_res, "raw_item_count", 0) or 0)
    discarded = int(getattr(sonda_res, "discarded_sem_codigo", 0) or 0)
    diag = _diagnostico_fonte_frota(
        use_sonda_primary=use_sonda_primary,
        configured=is_configured(),
        http_err=http_err,
        n_veiculos_sonda=len(by),
        raw_items=raw_items,
        discarded=discarded,
    )

    if use_sonda_primary:
        mysql_by: dict[str, dict[str, Any]] = {}
        for r in rows:
            raw = row_to_vehicle_raw(dict(r), m)
            code = str(raw.get("prefixo") or "").strip()
            if code:
                mysql_by[code] = dict(r)
        codes = sorted(set(mysql_by.keys()) | set(by.keys()))
        veiculos = []
        for code in codes:
            mr = mysql_by.get(code)
            mysql_raw = row_to_vehicle_raw(mr, m) if mr else None
            sonda_rec = by.get(code)
            veiculos.append(_envelope_sonda_primary(mysql_raw, sonda_rec, sonda_http_error=http_err))
    else:
        veiculos = [_envelope_from_mysql_row(dict(r), by, sonda_res) for r in rows]

    prefixos = [str(v.get("prefixo") or "").strip() for v in veiculos]
    ctx_by = contexto_ssov_por_prefixos(prefixos)
    for v in veiculos:
        code = str(v.get("prefixo") or "").strip()
        ctx = ctx_by.get(code) or {}
        _inject_liberacao_do_ctx(v, ctx)
        v.update(_avaliar_localizacao(v, ctx, base_critica=False))
        v["ssov_recolhimento_ativo"] = bool(ctx.get("ssov_recolhimento_ativo"))
        v["ssov_preventiva_hoje"] = bool(ctx.get("ssov_preventiva_hoje"))
        cat, cor = classify_vehicle_status(v)
        v["mapa_cor"] = cor
        v["ssov_categoria"] = cat
        _patch_textos_liberacao_mecanica(v)

    tz = (getattr(Config, "DATA_EVENT_TIMEZONE", None) or "").strip() or "UTC"
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return {
        "veiculos": veiculos,
        "sonda": _sonda_meta(sonda_res),
        "tempo": {
            "assume_timezone_naive_mysql": tz,
            "consulta_servidor_utc": now,
            "fonte_principal_frota": "sonda" if use_sonda_primary else "mysql",
            "diagnostico_frota": diag,
        },
    }


def list_fleet_latest() -> list[dict[str, Any]]:
    return list_fleet_bundle()["veiculos"]


def get_vehicle_detail(prefixo: str) -> dict[str, Any] | None:
    m = ColumnMap.from_config(Config)
    code = str(prefixo).strip()
    row = db_tempo_real.fetch_latest_row_for_prefixo(prefixo)
    mysql_raw = row_to_vehicle_raw(dict(row), m) if row else None

    override = None
    if Config.SONDA_VEHICLE_PATH_TEMPLATE.strip():
        override = fetch_vehicle_by_prefixo(prefixo)

    sonda_res = fetch_fleet_snapshot()
    by = getattr(sonda_res, "by_vehicle_code", {}) or {}
    http_err: str | None = getattr(sonda_res, "error", None)
    if override is not None:
        http_err = None

    use_sonda_primary = is_configured() and not http_err and (len(by) > 0 or override is not None)

    if use_sonda_primary:
        sonda_rec = override if override is not None else by.get(code)
        if mysql_raw is None and not sonda_rec:
            return None
        envelope = _envelope_sonda_primary(mysql_raw, sonda_rec, sonda_http_error=http_err)
    else:
        if not row:
            return None
        envelope = _envelope_from_mysql_row(dict(row), by, sonda_res, sonda_override=override)

    ctx = contexto_ssov_por_prefixos([code]).get(code) or {}
    _inject_liberacao_do_ctx(envelope, ctx)
    envelope.update(_avaliar_localizacao(envelope, ctx, base_critica=False))
    envelope["ssov_recolhimento_ativo"] = bool(ctx.get("ssov_recolhimento_ativo"))
    envelope["ssov_preventiva_hoje"] = bool(ctx.get("ssov_preventiva_hoje"))
    _cat, _cor = classify_vehicle_status(envelope)
    envelope["mapa_cor"] = _cor
    envelope["ssov_categoria"] = _cat
    _patch_textos_liberacao_mecanica(envelope)
    envelope["sonda_consulta"] = _sonda_meta(sonda_res)
    return envelope


def get_vehicle_history(prefixo: str, limit: int = 50) -> list[dict[str, Any]]:
    rows = db_tempo_real.fetch_history_prefixo(prefixo, limit=limit)
    out: list[dict[str, Any]] = []
    for r in rows:
        m = ColumnMap.from_config(Config)
        raw = row_to_vehicle_raw(dict(r), m)
        st = compute_status(raw)
        norm_api = dict(raw)
        iso_h = serialize_datetime_for_api(raw.get("hora_posicao"))
        if iso_h:
            norm_api["hora_posicao"] = iso_h
        out.append(
            {
                **{k: _serialize_value(v) for k, v in dict(r).items()},
                "_normalizado": norm_api,
                "_status": {
                    "operacional": st.operacional,
                    "soltura": st.soltura,
                    "mapa_cor": st.mapa_cor,
                    "status_comunicacao": st.status_comunicacao,
                    "status_posicao": st.status_posicao,
                    "motivo_soltura": st.motivo_soltura,
                },
            }
        )
    return out


def list_carros_para_localizar() -> dict[str, Any]:
    bundle = list_fleet_bundle()
    veiculos = list(bundle.get("veiculos") or [])
    health = db_tempo_real.fetch_table_health()
    atraso_global = health.get("minutos_desde_ultimo_evento_global")
    base_critica = isinstance(atraso_global, (int, float)) and atraso_global >= Config.LOCALIZACAO_STALE_MEDIA_MIN
    prefixos = [str(v.get("prefixo") or "").strip() for v in veiculos]
    ctx_by = contexto_ssov_por_prefixos(prefixos)
    enriched = []
    for v in veiculos:
        code = str(v.get("prefixo") or "").strip()
        vv = dict(v)
        ctx = ctx_by.get(code) or {}
        _inject_liberacao_do_ctx(vv, ctx)
        vv.update(_avaliar_localizacao(vv, ctx, base_critica=bool(base_critica)))
        vv["ssov_recolhimento_ativo"] = bool(ctx.get("ssov_recolhimento_ativo"))
        vv["ssov_preventiva_hoje"] = bool(ctx.get("ssov_preventiva_hoje"))
        cat, cor = classify_vehicle_status(vv)
        vv["mapa_cor"] = cor
        vv["ssov_categoria"] = cat
        _patch_textos_liberacao_mecanica(vv)
        enriched.append(vv)
    enriched = _dedupe_localizacao_por_prefixo(enriched)

    def sort_key(x: dict[str, Any]) -> tuple[int, int, str]:
        mins = x.get("minutos_sem_atualizacao")
        mins_ord = int(mins) if isinstance(mins, (int, float)) else -1
        return (-_prioridade_ordem(str(x.get("prioridade_localizacao") or "")), -mins_ord, str(x.get("prefixo") or ""))

    enriched.sort(key=sort_key)
    kpis = _compute_kpis_localizacao(enriched)
    return {
        "veiculos": enriched,
        "kpis": kpis,
        "tempo": bundle.get("tempo") or {},
        "sonda": bundle.get("sonda") or {},
        "saude_tabela": health,
    }


def _compute_kpis_localizacao(veiculos: list[dict[str, Any]]) -> dict[str, int]:
    os_abertas = 0
    preventivas_vencidas = 0
    criticos = 0
    sem_gps = 0
    aguardando_recolhimento = 0
    preventivas_proximas = 0
    garagem_com_pendencia = 0

    for v in veiculos:
        os_open = bool(v.get("os_abertas"))
        prev = str(v.get("preventiva_situacao") or "em_dia").lower()
        prio = str(v.get("prioridade_localizacao") or "").lower()
        na_garagem = v.get("na_garagem") is True
        fora_garagem = v.get("na_garagem") is False
        sem_gps_flag = str(v.get("status_comunicacao") or "") == "SEM_ATUALIZACAO"
        cat = str(v.get("ssov_categoria") or "").lower()

        if os_open:
            os_abertas += 1
        if prev == "vencida":
            preventivas_vencidas += 1
        if cat == "critico" or (not cat and prio == "alta"):
            criticos += 1
        if cat == "sem_gps" or (not cat and sem_gps_flag):
            sem_gps += 1
        if cat == "recolhimento" or (os_open and fora_garagem):
            aguardando_recolhimento += 1
        if prev == "proxima":
            preventivas_proximas += 1
        if na_garagem and (os_open or prev == "vencida"):
            garagem_com_pendencia += 1

    return {
        "os_abertas": os_abertas,
        "preventivas_vencidas": preventivas_vencidas,
        "criticos": criticos,
        "sem_gps": sem_gps,
        "aguardando_recolhimento": aguardando_recolhimento,
        "preventivas_proximas": preventivas_proximas,
        "garagem_com_pendencia": garagem_com_pendencia,
    }


def _dedupe_localizacao_por_prefixo(veiculos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Garante 1 linha por prefixo mantendo o registro mais crítico para decisão operacional."""

    def os_rank(v: dict[str, Any]) -> int:
        os_abertas = list(v.get("os_abertas") or [])
        if not os_abertas:
            return 0
        return _prioridade_ordem(str((os_abertas[0] or {}).get("prioridade") or ""))

    def preventiva_rank(v: dict[str, Any]) -> int:
        s = str(v.get("preventiva_situacao") or "em_dia").lower()
        if s == "vencida":
            return 2
        if s == "proxima":
            return 1
        return 0

    def mins_rank(v: dict[str, Any]) -> int:
        mins = v.get("minutos_sem_atualizacao")
        return int(mins) if isinstance(mins, (int, float)) else -1

    def score(v: dict[str, Any]) -> tuple[int, int, int, int]:
        return (
            _prioridade_ordem(str(v.get("prioridade_localizacao") or "")),
            os_rank(v),
            preventiva_rank(v),
            mins_rank(v),
        )

    by_prefixo: dict[str, dict[str, Any]] = {}
    for v in veiculos:
        prefixo = str(v.get("prefixo") or "").strip()
        if not prefixo:
            continue
        atual = by_prefixo.get(prefixo)
        if atual is None or score(v) > score(atual):
            by_prefixo[prefixo] = v

    return list(by_prefixo.values())


def get_kpis_operacionais() -> dict[str, Any]:
    data = list_carros_para_localizar()
    return {
        "kpis": data.get("kpis") or {},
        "saude_tabela": data.get("saude_tabela") or {},
        "tempo": data.get("tempo") or {},
    }
