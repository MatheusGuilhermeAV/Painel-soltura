from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from config import Config
from services.schema import parse_datetime


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def minutes_since(ts: datetime | None) -> float | None:
    if ts is None:
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    delta = _now_utc() - ts.astimezone(timezone.utc)
    return max(0.0, delta.total_seconds() / 60.0)


def trip_status_active(trip_status: Any) -> bool | None:
    if trip_status is None or str(trip_status).strip() == "":
        return None
    v = str(trip_status).strip().upper()
    allowed = {x.strip().upper() for x in Config.SONDA_TRIP_ACTIVE_VALUES.split(",") if x.strip()}
    if v in allowed:
        return True
    return None


def status_comunicacao_label(mins: float | None) -> str:
    if mins is None:
        return "DESCONHECIDO"
    if mins >= Config.STALE_CRITICAL_MINUTES:
        return "SEM_ATUALIZACAO"
    if mins >= Config.STALE_ATTENTION_MINUTES:
        return "ATRASO_LEVE"
    return "ATUALIZADO"


def status_posicao_label(
    lat: Any,
    lon: Any,
    na_garagem: bool | None,
) -> str:
    try:
        float(lat)
        float(lon)
    except (TypeError, ValueError):
        return "SEM_POSICAO_VALIDA"
    if na_garagem is True:
        return "NA_GARAGEM"
    if na_garagem is False:
        return "FORA_GARAGEM"
    return "INDEFINIDO_SEM_CERCA"


def infer_em_viagem(vehicle: dict[str, Any]) -> bool | None:
    ts = trip_status_active(vehicle.get("trip_status"))
    if ts is True:
        return True

    linha = vehicle.get("linha")
    viagem = vehicle.get("viagem")
    velocidade = vehicle.get("velocidade")
    ignicao = vehicle.get("ignicao")

    s_linha = str(linha).strip() if linha is not None else ""
    s_viagem = str(viagem).strip() if viagem is not None else ""
    if s_linha and s_linha not in ("0", "-", "—", "N/A"):
        return True
    if s_viagem and s_viagem.upper() not in ("0", "N", "NA", "NONE", ""):
        return True
    try:
        v = float(velocidade)
        if v > Config.STOPPED_SPEED_KMH:
            return True
    except (TypeError, ValueError):
        pass
    if ignicao is not None:
        ig = str(ignicao).strip().upper()
        if ig in ("1", "LIGADA", "ON", "TRUE", "S"):
            return True
    return None


def _motivo_padrao(soltura: str, em_viagem: bool | None, na_garagem: bool | None) -> str:
    if "Não liberar" in soltura:
        if em_viagem is True:
            return "Viagem ou operação ativa."
        return "Não atende critérios de liberação."
    if "Pode liberar" in soltura:
        if na_garagem is True:
            return "Na garagem, sem viagem ativa aparente."
        return "Liberável sob avaliação local."
    return "Avaliar com contexto da operação."


@dataclass
class StatusResult:
    operacional: str
    soltura: str
    mapa_cor: str
    atencao: bool
    na_garagem: bool | None
    minutos_sem_atualizacao: float | None
    em_viagem_inferido: bool | None
    observacao: str
    status_comunicacao: str
    status_posicao: str
    motivo_soltura: str


def compute_status(vehicle: dict[str, Any]) -> StatusResult:
    lat = vehicle.get("latitude")
    lon = vehicle.get("longitude")
    hora = parse_datetime(vehicle.get("hora_posicao"))
    mins = minutes_since(hora)

    na_garagem: bool | None = None
    if (
        lat is not None
        and lon is not None
        and Config.GARAGE_LAT is not None
        and Config.GARAGE_LON is not None
    ):
        try:
            d = haversine_m(float(lat), float(lon), Config.GARAGE_LAT, Config.GARAGE_LON)
            na_garagem = d <= float(Config.GARAGE_RADIUS_METERS)
        except (TypeError, ValueError):
            na_garagem = None

    em_viagem = infer_em_viagem(vehicle)

    operacional = "Desconhecido"
    soltura = "Avaliar"
    mapa_cor = "#eab308"
    atencao = False
    obs_parts: list[str] = []

    if mins is None:
        operacional = "Sem atualização"
        soltura = "Avaliar"
        mapa_cor = "#ef4444"
        atencao = True
        obs_parts.append("Sem horário de posição.")
    elif mins >= Config.STALE_CRITICAL_MINUTES:
        operacional = "Sem atualização"
        soltura = "Não liberar"
        mapa_cor = "#ef4444"
        atencao = True
        obs_parts.append(f"GPS sem atualização (~{int(mins)} min).")
    elif mins >= Config.STALE_ATTENTION_MINUTES:
        operacional = "Atenção — atraso no rastreador"
        soltura = "Avaliar"
        mapa_cor = "#f59e0b"
        atencao = True
        obs_parts.append(f"Atraso no GPS (~{int(mins)} min).")
    elif na_garagem is True:
        operacional = "Na garagem"
        if em_viagem is True:
            soltura = "Avaliar"
            obs_parts.append("Garagem com indício de viagem ativa.")
        else:
            soltura = "Pode liberar"
        mapa_cor = "#3b82f6"
    elif na_garagem is False:
        try:
            spd = float(vehicle.get("velocidade"))
        except (TypeError, ValueError):
            spd = None
        if (
            spd is not None
            and spd <= Config.STOPPED_SPEED_KMH
            and mins is not None
            and mins >= Config.STOPPED_ATTENTION_MINUTES
        ):
            operacional = "Parado fora da garagem"
            soltura = "Não liberar" if em_viagem is True else "Avaliar"
            mapa_cor = "#f59e0b"
            atencao = True
            obs_parts.append("Parado fora da garagem por tempo prolongado.")
        elif em_viagem is True:
            operacional = "Em operação"
            soltura = "Não liberar"
            mapa_cor = "#22c55e"
        else:
            operacional = "Em deslocamento / fora da garagem"
            soltura = "Avaliar"
            mapa_cor = "#eab308"
            atencao = True
    else:
        if em_viagem is True:
            operacional = "Em operação"
            soltura = "Não liberar"
            mapa_cor = "#22c55e"
        else:
            operacional = "Fora da garagem (cerca não configurada)"
            soltura = "Avaliar"
            mapa_cor = "#eab308"
            obs_parts.append("Cerca da garagem não configurada.")

    com = status_comunicacao_label(mins)
    pos = status_posicao_label(lat, lon, na_garagem)
    obs_text = " ".join(obs_parts).strip()
    motivo = obs_text if obs_text else _motivo_padrao(soltura, em_viagem, na_garagem)

    return StatusResult(
        operacional=operacional,
        soltura=soltura,
        mapa_cor=mapa_cor,
        atencao=atencao,
        na_garagem=na_garagem,
        minutos_sem_atualizacao=mins,
        em_viagem_inferido=em_viagem,
        observacao=obs_text,
        status_comunicacao=com,
        status_posicao=pos,
        motivo_soltura=motivo,
    )


def classify_vehicle_status(vehicle: dict[str, Any]) -> tuple[str, str]:
    """
    Classificação SSOV para cor no mapa e KPIs.
    Ordem de prioridade: recolhimento > sem GPS > preventiva do dia > crítico > atenção > disponível.

    Cores espelham docs/AMD/003-tokens-cor-e-estados.md — alterar apenas com ADR e atualização dupla (CSS).

    Retorna (categoria, cor_hex).
    """
    # Tokens Eucatur / operação (ver AMD 003).
    COR_RECOLHIMENTO = "#7A0B12"
    COR_SEM_GPS = "#5F6B7A"
    COR_PREVENTIVA = "#0369C5"
    COR_CRITICO = "#E30613"
    COR_ATENCAO = "#D97706"
    COR_DISPONIVEL = "#009639"

    if vehicle.get("ssov_recolhimento_ativo"):
        return ("recolhimento", COR_RECOLHIMENTO)

    st = compute_status(vehicle)
    comm = st.status_comunicacao

    if comm == "SEM_ATUALIZACAO":
        return ("sem_gps", COR_SEM_GPS)
    try:
        float(vehicle.get("latitude"))
        float(vehicle.get("longitude"))
    except (TypeError, ValueError):
        return ("sem_gps", COR_SEM_GPS)

    if vehicle.get("ssov_preventiva_hoje"):
        return ("preventiva_dia", COR_PREVENTIVA)

    mins = st.minutos_sem_atualizacao
    mins_crit = mins is not None and mins >= float(Config.STALE_CRITICAL_MINUTES)
    prio = str(vehicle.get("prioridade_localizacao") or "").lower()
    prev = str(vehicle.get("preventiva_situacao") or "em_dia").lower()
    os_abertas = list(vehicle.get("os_abertas") or [])
    os_alta = bool(os_abertas and str(os_abertas[0].get("prioridade") or "").lower() == "alta")

    if prio == "alta" or prev == "vencida" or mins_crit or os_alta:
        return ("critico", COR_CRITICO)

    if st.atencao or comm == "ATRASO_LEVE" or prev == "proxima":
        return ("atencao", COR_ATENCAO)

    if "Pode liberar" in str(st.soltura or ""):
        return ("disponivel", COR_DISPONIVEL)

    return ("atencao", COR_ATENCAO)
