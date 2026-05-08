from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

from zoneinfo import ZoneInfo

from config import Config


def _pick(row: Mapping[str, Any], *keys: str) -> Any:
    """Busca valor na linha com chaves case-insensitive."""
    lower = {str(k).lower(): v for k, v in row.items()}
    for k in keys:
        if k.lower() in lower:
            return lower[k.lower()]
    return None


@dataclass
class ColumnMap:
    prefixo: str
    placa: str
    lat: str
    lon: str
    hora_posicao: str
    linha: str
    sentido: str
    motorista: str
    viagem: str
    velocidade: str
    ignicao: str

    @classmethod
    def from_config(cls, c: type[Config]) -> ColumnMap:
        return cls(
            prefixo=c.COL_PREFIXO,
            placa=c.COL_PLACA,
            lat=c.COL_LAT,
            lon=c.COL_LON,
            hora_posicao=c.COL_HORA_POSICAO,
            linha=c.COL_LINHA,
            sentido=c.COL_SENTIDO,
            motorista=c.COL_MOTORISTA,
            viagem=c.COL_VIAGEM,
            velocidade=c.COL_VELOCIDADE,
            ignicao=c.COL_IGNICAO,
        )


def row_to_vehicle_raw(row: Mapping[str, Any], m: ColumnMap) -> dict[str, Any]:
    return {
        "prefixo": _pick(row, m.prefixo, "vehicle_code", "PREFIXO", "prefixo_veiculo"),
        "placa": _pick(row, m.placa, "PLACA"),
        "latitude": _pick(row, m.lat, "LAT", "LATITUDE"),
        "longitude": _pick(row, m.lon, "LON", "LONGITUDE"),
        "hora_posicao": _pick(row, m.hora_posicao, "date", "DATA_HORA", "DT_POSICAO"),
        "linha": _pick(row, m.linha, "LINHA", "COD_LINHA"),
        "sentido": _pick(row, m.sentido, "SENTIDO", "DIRECAO"),
        "motorista": _pick(row, m.motorista, "MOTORISTA", "CONDUTOR"),
        "viagem": _pick(row, m.viagem, "VIAGEM", "COD_VIAGEM"),
        "velocidade": _pick(row, m.velocidade, "VELOCIDADE", "VEL"),
        "ignicao": _pick(row, m.ignicao, "IGNICAO", "IGN"),
    }


def _attach_event_timezone(dt: datetime) -> datetime:
    if dt.tzinfo is not None:
        return dt
    tzname = getattr(Config, "DATA_EVENT_TIMEZONE", "") or ""
    if not tzname:
        return dt.replace(tzinfo=timezone.utc)
    try:
        return dt.replace(tzinfo=ZoneInfo(tzname))
    except Exception:
        return dt.replace(tzinfo=timezone.utc)


def parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return _attach_event_timezone(value)
    if isinstance(value, (int, float)):
        return None
    s = str(value).strip()
    if not s:
        return None
    if "T" in s and len(s) >= 19:
        try:
            cand = s.replace("Z", "+00:00") if s.endswith("Z") else s
            parsed = datetime.fromisoformat(cand[:32])
            if parsed.tzinfo is not None:
                return parsed
            return _attach_event_timezone(parsed)
        except ValueError:
            pass
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%d/%m/%Y %H:%M:%S",
    ):
        try:
            parsed = datetime.strptime(s[:26], fmt)
            return _attach_event_timezone(parsed)
        except ValueError:
            continue
    return None


def serialize_datetime_for_api(value: Any) -> str | None:
    """
    Instante em ISO 8601 com sufixo Z (UTC) para o JSON.
    Sem isso, o JavaScript pode interpretar string sem fuso como horário local do PC.
    """
    dt: datetime | None = None
    if isinstance(value, datetime):
        dt = _attach_event_timezone(value)
    else:
        dt = parse_datetime(value)
    if dt is None:
        return None
    utc = dt.astimezone(timezone.utc).replace(microsecond=0)
    return utc.isoformat().replace("+00:00", "Z")
