from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from typing import Any, Sequence

import pymysql
from pymysql.cursors import DictCursor
from zoneinfo import ZoneInfo

from config import Config
from services.schema import parse_datetime, serialize_datetime_for_api
from services.status import minutes_since


def get_connection():
    if not Config.MYSQL_USER:
        raise RuntimeError("MYSQL_USER não configurado no .env")
    return pymysql.connect(
        host=Config.MYSQL_HOST,
        port=Config.MYSQL_PORT,
        user=Config.MYSQL_USER,
        password=Config.MYSQL_PASSWORD,
        database=Config.MYSQL_DATABASE,
        charset="utf8mb4",
        cursorclass=DictCursor,
        connect_timeout=10,
        read_timeout=30,
        write_timeout=30,
    )


def list_table_columns() -> list[str]:
    """Útil para ajustar COL_* no .env após DESCRIBE."""
    sql = """
        SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = %s AND TABLE_NAME = %s
        ORDER BY ORDINAL_POSITION
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (Config.MYSQL_DATABASE, Config.MYSQL_TABLE))
            rows = cur.fetchall()
    return [r["COLUMN_NAME"] for r in rows]


def fetch_latest_per_prefixo(limit: int = 2000) -> Sequence[dict[str, Any]]:
    """
    Retorna a linha mais recente por prefixo (subquery).
    Ajuste se a PK ou ordenação real for diferente na sua base.
    """
    t = Config.MYSQL_TABLE
    col_ts = Config.COL_HORA_POSICAO
    col_pfx = Config.COL_PREFIXO
    # Evita f-string com nome de tabela vindo só de Config (operador controla .env)
    sql = f"""
        SELECT v.*
        FROM `{t}` v
        INNER JOIN (
            SELECT `{col_pfx}` AS pfx, MAX(`{col_ts}`) AS mx
            FROM `{t}`
            GROUP BY `{col_pfx}`
        ) x ON v.`{col_pfx}` = x.pfx AND v.`{col_ts}` = x.mx
        ORDER BY v.`{col_ts}` DESC
        LIMIT %s
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (limit,))
            return cur.fetchall()


def fetch_latest_row_for_prefixo(prefixo: str) -> dict[str, Any] | None:
    """Último registro de um único veículo (ordenado por data)."""
    t = Config.MYSQL_TABLE
    col_ts = Config.COL_HORA_POSICAO
    col_pfx = Config.COL_PREFIXO
    sql = f"""
        SELECT *
        FROM `{t}`
        WHERE `{col_pfx}` = %s
        ORDER BY `{col_ts}` DESC
        LIMIT 1
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (prefixo,))
            row = cur.fetchone()
    return dict(row) if row else None


def count_rows() -> int:
    t = Config.MYSQL_TABLE
    sql = f"SELECT COUNT(*) AS n FROM `{t}`"
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            r = cur.fetchone()
    return int(r["n"]) if r else 0


def fetch_table_health() -> dict[str, Any]:
    """
    Diagnóstico da carga na tabela de percurso: MAX(date), volume do dia,
    veículos com pelo menos um ponto hoje. Assume datas naive no MySQL
    alinhadas a DATA_EVENT_TIMEZONE (mesma regra do parse_datetime).
    """
    t = Config.MYSQL_TABLE
    col_dt = Config.COL_HORA_POSICAO
    col_pfx = Config.COL_PREFIXO
    tzname = (getattr(Config, "DATA_EVENT_TIMEZONE", None) or "").strip() or "UTC"
    try:
        tz = ZoneInfo(tzname)
    except Exception:
        tz = ZoneInfo("UTC")

    now_local = datetime.now(tz)
    day_start_local = datetime.combine(now_local.date(), time.min, tzinfo=tz)
    day_end_local = day_start_local + timedelta(days=1)
    start_naive = day_start_local.replace(tzinfo=None)
    end_naive = day_end_local.replace(tzinfo=None)

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(f"SELECT COUNT(*) AS n FROM `{t}`")
            total_registros = int(cur.fetchone()["n"])
            cur.execute(f"SELECT MAX(`{col_dt}`) AS mx FROM `{t}`")
            mx_raw = cur.fetchone()["mx"]
            cur.execute(
                f"SELECT COUNT(*) AS n FROM `{t}` WHERE `{col_dt}` >= %s AND `{col_dt}` < %s",
                (start_naive, end_naive),
            )
            registros_hoje = int(cur.fetchone()["n"])
            cur.execute(
                f"""
                SELECT COUNT(DISTINCT `{col_pfx}`) AS n
                FROM `{t}`
                WHERE `{col_dt}` >= %s AND `{col_dt}` < %s
                """,
                (start_naive, end_naive),
            )
            veiculos_com_posicao_hoje = int(cur.fetchone()["n"])

    mx_dt = parse_datetime(mx_raw)
    ultima_iso = serialize_datetime_for_api(mx_raw) if mx_raw is not None else None
    minutos = minutes_since(mx_dt)
    consulta = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    return {
        "tabela": t,
        "coluna_data": col_dt,
        "total_registros": total_registros,
        "ultima_data_tabela_iso": ultima_iso,
        "minutos_desde_ultimo_evento_global": minutos,
        "registros_hoje": registros_hoje,
        "veiculos_com_posicao_hoje": veiculos_com_posicao_hoje,
        "consulta_servidor_utc": consulta,
        "timezone_referencia_carga": tzname,
        "janela_hoje_inicio_local": start_naive.strftime("%Y-%m-%d %H:%M:%S"),
        "janela_hoje_fim_local_exclusivo": end_naive.strftime("%Y-%m-%d %H:%M:%S"),
        "nota_carga": "Contagens 'hoje' usam a coluna de data no MySQL comparada ao intervalo "
        f"local [{start_naive} .. {end_naive}) em DATA_EVENT_TIMEZONE={tzname}.",
    }


def fetch_history_prefixo(prefixo: str, limit: int = 50) -> Sequence[dict[str, Any]]:
    t = Config.MYSQL_TABLE
    col_ts = Config.COL_HORA_POSICAO
    col_pfx = Config.COL_PREFIXO
    sql = f"""
        SELECT *
        FROM `{t}`
        WHERE `{col_pfx}` = %s
        ORDER BY `{col_ts}` DESC
        LIMIT %s
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (prefixo, limit))
            return cur.fetchall()
