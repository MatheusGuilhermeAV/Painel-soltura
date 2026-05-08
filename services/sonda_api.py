"""
Cliente HTTP da API Sonda.

Configure no .env a URL base, a rota de frota (SONDA_FLEET_PATH) e os nomes reais dos
campos JSON (SONDA_FIELD_*). Veja a matriz em docs/PLANO_TECNICO_PROJETO.md.
"""

from __future__ import annotations

import json
import logging
import ssl
from dataclasses import dataclass, field
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from config import Config

logger = logging.getLogger(__name__)


@dataclass
class SondaFetchResult:
    """Resultado de uma chamada em lote à Sonda (lista normalizada por veículo)."""

    records: list[dict[str, Any]] = field(default_factory=list)
    by_vehicle_code: dict[str, dict[str, Any]] = field(default_factory=dict)
    http_status: int | None = None
    error: str | None = None
    # Diagnóstico: itens na lista após SONDA_RESPONSE_ROOT_KEY (objetos dict)
    raw_item_count: int = 0
    discarded_sem_codigo: int = 0


def is_configured() -> bool:
    return bool(Config.SONDA_API_BASE and Config.SONDA_FLEET_PATH)


def _open_url(req: Request, timeout: int):
    if Config.SONDA_VERIFY_SSL:
        return urlopen(req, timeout=timeout)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return urlopen(req, timeout=timeout, context=ctx)


def _auth_headers() -> dict[str, str]:
    h: dict[str, str] = {"Accept": "application/json"}
    if not Config.SONDA_API_TOKEN:
        return h
    if Config.SONDA_AUTH_TYPE == "apikey":
        name = Config.SONDA_API_KEY_HEADER or "X-API-Key"
        h[name] = Config.SONDA_API_TOKEN
    else:
        h["Authorization"] = f"Bearer {Config.SONDA_API_TOKEN}"
    return h


def _get_ci(d: dict[str, Any], key: str) -> Any:
    if not key:
        return None
    lower = {str(k).lower(): v for k, v in d.items()}
    return lower.get(key.lower())


def _navigate_list_payload(data: Any) -> list[Any]:
    root = (Config.SONDA_RESPONSE_ROOT_KEY or "").strip()
    if not root:
        return data if isinstance(data, list) else []
    cur: Any = data
    for part in root.split("."):
        if not isinstance(cur, dict):
            return []
        cur = cur.get(part)
    return cur if isinstance(cur, list) else []


def normalize_sonda_record(raw: dict[str, Any]) -> dict[str, Any]:
    """Normaliza um objeto JSON da Sonda para o merge (vocabulário interno)."""

    def pick(primary: str, *fallbacks: str) -> Any:
        for name in (primary, *fallbacks):
            if name and (v := _get_ci(raw, name)) is not None:
                return v
        return None

    code = pick(
        Config.SONDA_FIELD_VEHICLE_CODE,
        "vehicle_code",
        "bus_code",
        "prefixo",
        "codigo",
        "bus_id",
        "fleet_code",
    )
    return {
        "vehicle_code": str(code).strip() if code is not None else "",
        "motorista": pick(Config.SONDA_FIELD_DRIVER_NAME, "motorista", "driverName"),
        "matricula_motorista": pick(Config.SONDA_FIELD_DRIVER_ID, "matricula", "matricula_motorista"),
        "viagem_id": pick(Config.SONDA_FIELD_TRIP_ID, "viagem", "tripId"),
        "trip_status": pick(Config.SONDA_FIELD_TRIP_STATUS, "tripStatus", "status_viagem"),
        "velocidade": pick(Config.SONDA_FIELD_SPEED, "velocidade"),
        "ignicao": pick(Config.SONDA_FIELD_IGNITION, "ignicao"),
        "linha": pick(Config.SONDA_FIELD_LINE, "linha", "route", "line"),
        "sentido": pick(Config.SONDA_FIELD_DIRECTION, "sentido"),
        "event_time": pick(Config.SONDA_FIELD_EVENT_TIME, "timestamp", "gps_time", "date"),
        "latitude": pick(
            Config.SONDA_FIELD_LAT,
            "latitude",
            "lat",
            "LAT",
            "y",
        ),
        "longitude": pick(
            Config.SONDA_FIELD_LON,
            "longitude",
            "lon",
            "lng",
            "LON",
            "x",
        ),
    }


def fetch_fleet_snapshot() -> SondaFetchResult:
    if not is_configured():
        return SondaFetchResult()

    base = Config.SONDA_API_BASE.rstrip("/") + "/"
    path = Config.SONDA_FLEET_PATH.lstrip("/")
    url = urljoin(base, path)
    req = Request(url, headers=_auth_headers(), method="GET")
    status_code: int | None = None

    try:
        with _open_url(req, Config.SONDA_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status_code = getattr(resp, "status", None) or resp.getcode()
    except HTTPError as e:
        msg = f"HTTP {e.code}: {e.reason}"
        logger.warning("Sonda HTTPError: %s", msg)
        return SondaFetchResult(http_status=e.code, error=msg)
    except URLError as e:
        msg = str(e.reason if hasattr(e, "reason") else e)
        logger.warning("Sonda URLError: %s", msg)
        return SondaFetchResult(error=msg)
    except Exception as e:
        msg = str(e)
        logger.exception("Sonda erro inesperado")
        return SondaFetchResult(error=msg)

    try:
        data = json.loads(body) if body else None
    except json.JSONDecodeError as e:
        return SondaFetchResult(http_status=status_code, error=f"JSON inválido: {e}")

    items = _navigate_list_payload(data)
    raw_item_count = sum(1 for x in items if isinstance(x, dict))
    records: list[dict[str, Any]] = []
    by_code: dict[str, dict[str, Any]] = {}
    discarded_sem_codigo = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        norm = normalize_sonda_record(item)
        code = norm.get("vehicle_code") or ""
        if not code:
            discarded_sem_codigo += 1
            continue
        records.append(norm)
        by_code[code] = norm

    return SondaFetchResult(
        records=records,
        by_vehicle_code=by_code,
        http_status=status_code,
        error=None,
        raw_item_count=raw_item_count,
        discarded_sem_codigo=discarded_sem_codigo,
    )


def fetch_vehicle_by_prefixo(prefixo: str) -> dict[str, Any] | None:
    tpl = (Config.SONDA_VEHICLE_PATH_TEMPLATE or "").strip()
    if not tpl or not Config.SONDA_API_BASE:
        return None

    base = Config.SONDA_API_BASE.rstrip("/") + "/"
    path = tpl.format(prefixo=prefixo).lstrip("/")
    url = urljoin(base, path)
    req = Request(url, headers=_auth_headers(), method="GET")
    try:
        with _open_url(req, Config.SONDA_TIMEOUT_SECONDS) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        logger.warning("Sonda fetch_vehicle_by_prefixo: %s", e)
        return None

    try:
        data = json.loads(body) if body else None
    except json.JSONDecodeError:
        return None

    if isinstance(data, dict):
        return normalize_sonda_record(data)
    return None
