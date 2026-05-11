import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _float(name: str, default: float | None) -> float | None:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-change-me")

    MYSQL_HOST = os.getenv("MYSQL_HOST", "127.0.0.1")
    MYSQL_PORT = _int("MYSQL_PORT", 3306)
    MYSQL_USER = os.getenv("MYSQL_USER", "")
    MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD", "")
    MYSQL_DATABASE = os.getenv("MYSQL_DATABASE", "soltura_tempo_real")
    MYSQL_TABLE = os.getenv("MYSQL_TABLE", "viagenspercursobusdor")

    # Padrão alinhado à tabela viagenspercursobusdor (confirmar com DESCRIBE em produção)
    COL_PREFIXO = os.getenv("COL_PREFIXO", "vehicle_code")
    COL_PLACA = os.getenv("COL_PLACA", "placa")
    COL_LAT = os.getenv("COL_LAT", "latitude")
    COL_LON = os.getenv("COL_LON", "longitude")
    COL_HORA_POSICAO = os.getenv("COL_HORA_POSICAO", "date")
    COL_LINHA = os.getenv("COL_LINHA", "linha")
    COL_SENTIDO = os.getenv("COL_SENTIDO", "sentido")
    COL_MOTORISTA = os.getenv("COL_MOTORISTA", "motorista")
    COL_VIAGEM = os.getenv("COL_VIAGEM", "viagem")
    COL_VELOCIDADE = os.getenv("COL_VELOCIDADE", "velocidade")
    COL_IGNICAO = os.getenv("COL_IGNICAO", "ignicao")

    STALE_ATTENTION_MINUTES = _int("STALE_ATTENTION_MINUTES", 20)
    STALE_CRITICAL_MINUTES = _int("STALE_CRITICAL_MINUTES", 60)
    STOPPED_ATTENTION_MINUTES = _int("STOPPED_ATTENTION_MINUTES", 15)
    STOPPED_SPEED_KMH = _float("STOPPED_SPEED_KMH", 3.0) or 3.0

    GARAGE_LAT = _float("GARAGE_LAT", None)
    GARAGE_LON = _float("GARAGE_LON", None)
    GARAGE_RADIUS_METERS = _float("GARAGE_RADIUS_METERS", 200.0) or 200.0

    SONDA_API_BASE = os.getenv("SONDA_API_BASE", "").rstrip("/")
    # Token/credencial: SONDA_API_TOKEN é o nome principal; SONDA_API_KEY aceita checklists genéricos.
    _t = os.getenv("SONDA_API_TOKEN", "").strip()
    _k = os.getenv("SONDA_API_KEY", "").strip()
    SONDA_API_TOKEN = _t or _k
    SONDA_AUTH_TYPE = os.getenv("SONDA_AUTH_TYPE", "bearer").strip().lower()
    SONDA_API_KEY_HEADER = os.getenv("SONDA_API_KEY_HEADER", "X-API-Key")
    SONDA_FLEET_PATH = os.getenv("SONDA_FLEET_PATH", "").strip()
    SONDA_VEHICLE_PATH_TEMPLATE = os.getenv("SONDA_VEHICLE_PATH_TEMPLATE", "").strip()
    SONDA_RESPONSE_ROOT_KEY = os.getenv("SONDA_RESPONSE_ROOT_KEY", "").strip()
    SONDA_TIMEOUT_SECONDS = _int("SONDA_TIMEOUT_SECONDS", 15)
    SONDA_VERIFY_SSL = os.getenv("SONDA_VERIFY_SSL", "1").strip().lower() in ("1", "true", "yes", "on")

    SONDA_FIELD_VEHICLE_CODE = os.getenv("SONDA_FIELD_VEHICLE_CODE", "vehicle_code")
    SONDA_FIELD_DRIVER_NAME = os.getenv("SONDA_FIELD_DRIVER_NAME", "driver_name")
    SONDA_FIELD_DRIVER_ID = os.getenv("SONDA_FIELD_DRIVER_ID", "driver_id")
    SONDA_FIELD_TRIP_ID = os.getenv("SONDA_FIELD_TRIP_ID", "trip_id")
    SONDA_FIELD_TRIP_STATUS = os.getenv("SONDA_FIELD_TRIP_STATUS", "trip_status")
    SONDA_FIELD_SPEED = os.getenv("SONDA_FIELD_SPEED", "speed")
    SONDA_FIELD_IGNITION = os.getenv("SONDA_FIELD_IGNITION", "ignition")
    SONDA_FIELD_LINE = os.getenv("SONDA_FIELD_LINE", "route")
    SONDA_FIELD_DIRECTION = os.getenv("SONDA_FIELD_DIRECTION", "direction")
    SONDA_FIELD_EVENT_TIME = os.getenv("SONDA_FIELD_EVENT_TIME", "gps_time")
    SONDA_FIELD_LAT = os.getenv("SONDA_FIELD_LAT", "latitude")
    SONDA_FIELD_LON = os.getenv("SONDA_FIELD_LON", "longitude")

    SONDA_TRIP_ACTIVE_VALUES = os.getenv(
        "SONDA_TRIP_ACTIVE_VALUES",
        "OPEN,ATIVA,EM_VIAGEM,IN_PROGRESS,ACTIVE,1",
    )

    # Timezone assumido para datas **naive** vindas do MySQL (ex.: coluna `date`).
    # Padrão: Manaus (AM), UTC−4, sem horário de verão.
    # Vazio = tratar naive como UTC.
    DATA_EVENT_TIMEZONE = os.getenv("DATA_EVENT_TIMEZONE", "America/Manaus").strip()
    LOCAL_DB_PATH = os.getenv("LOCAL_DB_PATH", str(Path(__file__).resolve().parent / "data" / "manutencao_local.db"))
    SSOV_DEFAULT_ADMIN_PASSWORD = os.getenv("SSOV_DEFAULT_ADMIN_PASSWORD", "admin")
    # Enquanto os níveis de acesso não forem fechados, libera escrita e leitura protegida.
    SSOV_ACESSO_LIVRE = _bool("SSOV_ACESSO_LIVRE", True)
    LOCALIZACAO_STALE_MEDIA_MIN = _int("LOCALIZACAO_STALE_MEDIA_MIN", 120)
    LOCALIZACAO_PREVENTIVA_PROXIMA_DIAS = _int("LOCALIZACAO_PREVENTIVA_PROXIMA_DIAS", 7)
