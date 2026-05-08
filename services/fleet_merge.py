from __future__ import annotations

from typing import Any


def _norm(x: Any) -> str:
    if x is None:
        return ""
    return str(x).strip()


def _empty_vehicle(prefixo: str) -> dict[str, Any]:
    return {
        "prefixo": prefixo or None,
        "placa": None,
        "latitude": None,
        "longitude": None,
        "hora_posicao": None,
        "linha": None,
        "sentido": None,
        "motorista": None,
        "matricula_motorista": None,
        "viagem": None,
        "velocidade": None,
        "ignicao": None,
        "trip_status": None,
    }


def _coords_ok(rec: dict[str, Any] | None) -> bool:
    if not rec:
        return False
    try:
        float(rec.get("latitude"))
        float(rec.get("longitude"))
        return True
    except (TypeError, ValueError):
        return False


def merge_sonda_with_mysql_fallback(
    mysql_raw: dict[str, Any] | None,
    sonda_vehicle: dict[str, Any] | None,
    *,
    sonda_configured: bool,
    sonda_http_error: str | None,
) -> tuple[dict[str, Any], dict[str, bool], dict[str, str], dict[str, Any]]:
    """
    Precedência operacional quando o lote da Sonda está disponível:
    - Posição, horário, linha e sentido exibidos: Sonda quando houver coordenadas válidas
      (e linha/sentido na Sonda quando preenchidos); caso contrário MySQL.
    - Telemetria / motorista / viagem: Sonda quando informado, senão MySQL.
    - Placa: MySQL quando existir linha na base.
    """
    flags: dict[str, bool] = {}
    fontes: dict[str, str] = {
        "posicao": "mysql",
        "ultima_atualizacao": "mysql",
        "linha": "mysql",
        "sentido": "mysql",
        "motorista": "mysql",
        "matricula_motorista": "mysql",
        "viagem": "mysql",
        "trip_status": "mysql",
        "velocidade": "mysql",
        "ignicao": "mysql",
    }
    extras: dict[str, Any] = {
        "linha_sonda": None,
        "sentido_sonda": None,
        "linha_mysql": None,
        "sentido_mysql": None,
        "sonda_http_error": None,
    }

    if not sonda_configured:
        flags["sonda_nao_configurada"] = True
        if mysql_raw:
            merged = dict(mysql_raw)
            return merged, flags, fontes, extras
        code = str((sonda_vehicle or {}).get("vehicle_code") or "").strip()
        return _empty_vehicle(code), flags, fontes, extras

    if mysql_raw:
        merged = dict(mysql_raw)
        extras["linha_mysql"] = mysql_raw.get("linha")
        extras["sentido_mysql"] = mysql_raw.get("sentido")
    else:
        code = str((sonda_vehicle or {}).get("vehicle_code") or "").strip()
        merged = _empty_vehicle(code)

    if sonda_http_error:
        flags["sonda_indisponivel"] = True
        extras["sonda_http_error"] = sonda_http_error
        flags["sem_dados_motorista"] = not _norm(merged.get("motorista"))
        flags["sem_dados_viagem"] = not _norm(merged.get("viagem")) and not _norm(merged.get("trip_status"))
        return merged, flags, fontes, extras

    if sonda_vehicle:
        extras["linha_sonda"] = sonda_vehicle.get("linha")
        extras["sentido_sonda"] = sonda_vehicle.get("sentido")

    sv = sonda_vehicle
    if not sv:
        flags["sonda_sem_registro_frota"] = True
    elif not _coords_ok(sv):
        flags["sonda_sem_coordenadas_frota"] = True
        if _coords_ok(merged):
            flags["posicao_fallback_mysql"] = True

    if sv and _coords_ok(sv):
        merged["latitude"] = sv.get("latitude")
        merged["longitude"] = sv.get("longitude")
        fontes["posicao"] = "sonda"
        if sv.get("event_time") is not None:
            merged["hora_posicao"] = sv.get("event_time")
            fontes["ultima_atualizacao"] = "sonda"
        else:
            fontes["ultima_atualizacao"] = "mysql" if mysql_raw and mysql_raw.get("hora_posicao") else "sonda"
            if mysql_raw and mysql_raw.get("hora_posicao"):
                flags["sonda_sem_horario_gps"] = True

        if _norm(sv.get("linha")):
            merged["linha"] = sv.get("linha")
            fontes["linha"] = "sonda"
        if _norm(sv.get("sentido")):
            merged["sentido"] = sv.get("sentido")
            fontes["sentido"] = "sonda"

        if sv.get("motorista") is not None:
            merged["motorista"] = sv.get("motorista")
            fontes["motorista"] = "sonda"
        if sv.get("matricula_motorista") is not None:
            merged["matricula_motorista"] = sv.get("matricula_motorista")
            fontes["matricula_motorista"] = "sonda"
        if sv.get("viagem_id") is not None:
            merged["viagem"] = sv.get("viagem_id")
            fontes["viagem"] = "sonda"
        if sv.get("trip_status") is not None:
            merged["trip_status"] = sv.get("trip_status")
            fontes["trip_status"] = "sonda"
        if sv.get("velocidade") is not None:
            merged["velocidade"] = sv.get("velocidade")
            fontes["velocidade"] = "sonda"
        if sv.get("ignicao") is not None:
            merged["ignicao"] = sv.get("ignicao")
            fontes["ignicao"] = "sonda"
    elif sv:
        if _coords_ok(merged):
            flags["posicao_fallback_mysql"] = True

        if sv.get("motorista") is not None:
            merged["motorista"] = sv.get("motorista")
            fontes["motorista"] = "sonda"
        if sv.get("matricula_motorista") is not None:
            merged["matricula_motorista"] = sv.get("matricula_motorista")
            fontes["matricula_motorista"] = "sonda"
        if sv.get("viagem_id") is not None:
            merged["viagem"] = sv.get("viagem_id")
            fontes["viagem"] = "sonda"
        if sv.get("trip_status") is not None:
            merged["trip_status"] = sv.get("trip_status")
            fontes["trip_status"] = "sonda"
        if sv.get("velocidade") is not None:
            merged["velocidade"] = sv.get("velocidade")
            fontes["velocidade"] = "sonda"
        if sv.get("ignicao") is not None:
            merged["ignicao"] = sv.get("ignicao")
            fontes["ignicao"] = "sonda"

        if _norm(sv.get("linha")) and not _norm(merged.get("linha")):
            merged["linha"] = sv.get("linha")
            fontes["linha"] = "sonda"
        if _norm(sv.get("sentido")) and not _norm(merged.get("sentido")):
            merged["sentido"] = sv.get("sentido")
            fontes["sentido"] = "sonda"

    if _norm(extras.get("linha_sonda")) and _norm(extras.get("linha_mysql")):
        if _norm(extras["linha_sonda"]) != _norm(extras["linha_mysql"]):
            flags["divergencia_linha"] = True
    if _norm(extras.get("sentido_sonda")) and _norm(extras.get("sentido_mysql")):
        if _norm(extras["sentido_sonda"]) != _norm(extras["sentido_mysql"]):
            flags["divergencia_sentido"] = True

    flags["sem_dados_motorista"] = not _norm(merged.get("motorista"))
    flags["sem_dados_viagem"] = not _norm(merged.get("viagem")) and not _norm(merged.get("trip_status"))

    return merged, flags, fontes, extras


def merge_mysql_with_sonda(
    mysql_vehicle: dict[str, Any],
    sonda_vehicle: dict[str, Any] | None,
    *,
    sonda_configured: bool,
    sonda_http_error: str | None,
) -> tuple[dict[str, Any], dict[str, bool], dict[str, str], dict[str, Any]]:
    """
    Precedência quando o MySQL é a fonte principal da frota (Sonda desligada,
    erro HTTP ou lote vazio):
    - Posição e horário: MySQL
    - Linha e sentido exibidos: MySQL (comparar com Sonda se existir)
    - Motorista, matrícula, viagem, telemetria: Sonda quando existir

    Flags (vocabulário v1.2): apenas chaves com valor True são retornadas no JSON,
    exceto chaves operacionais sempre computadas em veiculos.py (ex.: classificacao_inferida).
    """
    merged: dict[str, Any] = dict(mysql_vehicle)
    fontes: dict[str, str] = {
        "posicao": "mysql",
        "ultima_atualizacao": "mysql",
        "linha": "mysql",
        "sentido": "mysql",
    }
    flags: dict[str, bool] = {}
    extras: dict[str, Any] = {"linha_sonda": None, "sentido_sonda": None, "sonda_http_error": None}

    if not sonda_configured:
        flags["sonda_nao_configurada"] = True
    elif sonda_http_error:
        flags["sonda_indisponivel"] = True
        extras["sonda_http_error"] = sonda_http_error
    elif sonda_vehicle is None:
        flags["sonda_sem_registro_frota"] = True

    if sonda_vehicle:
        fontes["motorista"] = "sonda"
        fontes["matricula_motorista"] = "sonda"
        fontes["viagem"] = "sonda"
        fontes["trip_status"] = "sonda"
        fontes["velocidade"] = "sonda"
        fontes["ignicao"] = "sonda"

        if sonda_vehicle.get("motorista") is not None:
            merged["motorista"] = sonda_vehicle.get("motorista")
        if sonda_vehicle.get("matricula_motorista") is not None:
            merged["matricula_motorista"] = sonda_vehicle.get("matricula_motorista")
        if sonda_vehicle.get("viagem_id") is not None:
            merged["viagem"] = sonda_vehicle.get("viagem_id")
        if sonda_vehicle.get("trip_status") is not None:
            merged["trip_status"] = sonda_vehicle.get("trip_status")
        if sonda_vehicle.get("velocidade") is not None:
            merged["velocidade"] = sonda_vehicle.get("velocidade")
        if sonda_vehicle.get("ignicao") is not None:
            merged["ignicao"] = sonda_vehicle.get("ignicao")

        extras["linha_sonda"] = sonda_vehicle.get("linha")
        extras["sentido_sonda"] = sonda_vehicle.get("sentido")

        if _norm(extras["linha_sonda"]) and _norm(merged.get("linha")):
            if _norm(extras["linha_sonda"]) != _norm(merged.get("linha")):
                flags["divergencia_linha"] = True
        if _norm(extras["sentido_sonda"]) and _norm(merged.get("sentido")):
            if _norm(extras["sentido_sonda"]) != _norm(merged.get("sentido")):
                flags["divergencia_sentido"] = True

    flags["sem_dados_motorista"] = not _norm(merged.get("motorista"))
    flags["sem_dados_viagem"] = not _norm(merged.get("viagem")) and not _norm(merged.get("trip_status"))

    return merged, flags, fontes, extras


def build_motivo_soltura(
    status_soltura: str,
    observacao: str,
    flags: dict[str, bool],
) -> str:
    """Texto curto, operacional, auditável."""
    parts: list[str] = []
    if observacao:
        parts.append(observacao)
    if flags.get("sonda_indisponivel"):
        parts.append("Sonda indisponível.")
    elif flags.get("sonda_sem_registro_frota") and not flags.get("sonda_nao_configurada"):
        parts.append("Sem registro na Sonda (lote).")
    if flags.get("posicao_fallback_mysql"):
        parts.append("Posição: MySQL (Sonda sem coordenadas neste veículo).")
    if flags.get("sonda_sem_coordenadas_frota") and not flags.get("posicao_fallback_mysql"):
        parts.append("Sonda sem latitude/longitude no lote.")
    if flags.get("sonda_sem_horario_gps"):
        parts.append("Horário GPS: MySQL (Sonda sem timestamp no lote).")
    if flags.get("divergencia_linha"):
        parts.append("Linha: divergência MySQL vs Sonda.")
    if flags.get("divergencia_sentido"):
        parts.append("Sentido: divergência MySQL vs Sonda.")
    if flags.get("sem_posicao_valida"):
        parts.append("Sem posição GPS válida.")
    if not parts:
        if "Pode liberar" in status_soltura:
            parts.append("Recolhido / sem indício forte de viagem ativa.")
        elif "Não liberar" in status_soltura:
            parts.append("Em operação ou bloqueio operacional.")
        else:
            parts.append("Dados insuficientes ou situação limite — avaliar.")
    return " ".join(parts).strip()
