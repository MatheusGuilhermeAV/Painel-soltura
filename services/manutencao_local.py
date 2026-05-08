from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from config import Config


def _db_path() -> Path:
    p = Path(Config.LOCAL_DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_db_path())
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS ordens_servico (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prefixo TEXT NOT NULL,
                defeito TEXT NOT NULL,
                data_abertura TEXT NOT NULL,
                situacao TEXT NOT NULL,
                prioridade TEXT NOT NULL,
                observacao TEXT,
                observacao_encerramento TEXT,
                data_encerramento TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS preventivas (
                prefixo TEXT PRIMARY KEY,
                tipo TEXT NOT NULL,
                ultima_preventiva TEXT,
                proxima_preventiva TEXT,
                situacao_manual TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS preventivas_agenda (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prefixo TEXT NOT NULL,
                data_preventiva TEXT NOT NULL,
                tipo TEXT NOT NULL,
                observacao TEXT,
                status TEXT NOT NULL,
                usuario_criacao TEXT,
                data_criacao TEXT NOT NULL,
                usuario_baixa TEXT,
                data_baixa TEXT
            );

            CREATE TABLE IF NOT EXISTS recolhimentos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prefixo TEXT NOT NULL,
                motivo TEXT NOT NULL,
                status TEXT NOT NULL,
                solicitante TEXT,
                observacao TEXT,
                usuario_criacao TEXT,
                data_criacao TEXT NOT NULL,
                data_finalizacao TEXT
            );

            CREATE TABLE IF NOT EXISTS acoes_operacionais (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                prefixo TEXT NOT NULL,
                tipo_acao TEXT NOT NULL,
                descricao TEXT,
                usuario TEXT,
                data_hora TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usuarios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nome TEXT NOT NULL,
                login TEXT NOT NULL UNIQUE,
                senha_hash TEXT NOT NULL,
                perfil TEXT NOT NULL,
                ativo INTEGER NOT NULL DEFAULT 1,
                data_criacao TEXT NOT NULL
            );
            """
        )
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(ordens_servico)").fetchall()}
        if "observacao_encerramento" not in cols:
            conn.execute("ALTER TABLE ordens_servico ADD COLUMN observacao_encerramento TEXT")
        if "data_encerramento" not in cols:
            conn.execute("ALTER TABLE ordens_servico ADD COLUMN data_encerramento TEXT")


def _now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _row_to_dict(r: sqlite3.Row) -> dict[str, Any]:
    return {k: r[k] for k in r.keys()}


def list_os(prefixo: str | None = None, situacao: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM ordens_servico WHERE 1=1"
    args: list[Any] = []
    if prefixo:
        sql += " AND prefixo = ?"
        args.append(prefixo.strip())
    if situacao:
        sql += " AND situacao = ?"
        args.append(situacao.strip())
    sql += " ORDER BY CASE prioridade WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, data_abertura DESC, id DESC"
    with _conn() as conn:
        cur = conn.execute(sql, args)
        return [_row_to_dict(r) for r in cur.fetchall()]


def create_os(payload: dict[str, Any]) -> dict[str, Any]:
    prefixo = str(payload.get("prefixo") or "").strip()
    defeito = str(payload.get("defeito") or "").strip()
    data_abertura = str(payload.get("data_abertura") or date.today().isoformat()).strip()
    situacao = str(payload.get("situacao") or "aberta").strip().lower()
    prioridade = str(payload.get("prioridade") or "media").strip().lower()
    observacao = str(payload.get("observacao") or "").strip() or None
    if not prefixo or not defeito:
        raise ValueError("prefixo e defeito são obrigatórios")
    if situacao not in {"aberta", "em_atendimento", "aguardando_recolhimento", "finalizada"}:
        raise ValueError("situacao inválida")
    if prioridade not in {"alta", "media", "baixa"}:
        raise ValueError("prioridade inválida")
    now = _now_iso()
    with _conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO ordens_servico (
              prefixo, defeito, data_abertura, situacao, prioridade, observacao,
              observacao_encerramento, data_encerramento, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                prefixo,
                defeito,
                data_abertura,
                situacao,
                prioridade,
                observacao,
                None,
                None,
                now,
                now,
            ),
        )
        rid = int(cur.lastrowid)
        row = conn.execute("SELECT * FROM ordens_servico WHERE id = ?", (rid,)).fetchone()
        return _row_to_dict(row)


def update_os(os_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {
        "defeito",
        "data_abertura",
        "situacao",
        "prioridade",
        "observacao",
        "observacao_encerramento",
        "data_encerramento",
    }
    sets: list[str] = []
    args: list[Any] = []
    for k in allowed:
        if k in payload:
            sets.append(f"{k} = ?")
            val = payload.get(k)
            if isinstance(val, str):
                val = val.strip()
            args.append(val)
    if "situacao" in payload:
        sit = str(payload.get("situacao") or "").strip().lower()
        if sit not in {"aberta", "em_atendimento", "aguardando_recolhimento", "finalizada"}:
            raise ValueError("situacao inválida")
        if sit == "finalizada" and "data_encerramento" not in payload:
            sets.append("data_encerramento = ?")
            args.append(_now_iso())
        if sit != "finalizada":
            sets.append("data_encerramento = ?")
            args.append(None)
            sets.append("observacao_encerramento = ?")
            args.append(None)
    if "prioridade" in payload:
        p = str(payload.get("prioridade") or "").strip().lower()
        if p not in {"alta", "media", "baixa"}:
            raise ValueError("prioridade inválida")
    if not sets:
        with _conn() as conn:
            row = conn.execute("SELECT * FROM ordens_servico WHERE id = ?", (os_id,)).fetchone()
            return _row_to_dict(row) if row else None
    sets.append("updated_at = ?")
    args.append(_now_iso())
    args.append(os_id)
    with _conn() as conn:
        conn.execute(f"UPDATE ordens_servico SET {', '.join(sets)} WHERE id = ?", args)
        row = conn.execute("SELECT * FROM ordens_servico WHERE id = ?", (os_id,)).fetchone()
        return _row_to_dict(row) if row else None


def list_preventivas(prefixo: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM preventivas"
    args: list[Any] = []
    if prefixo:
        sql += " WHERE prefixo = ?"
        args.append(prefixo.strip())
    sql += " ORDER BY prefixo"
    with _conn() as conn:
        rows = conn.execute(sql, args).fetchall()
    out = []
    for r in rows:
        item = _row_to_dict(r)
        item["situacao"] = compute_preventiva_situacao(item.get("proxima_preventiva"), item.get("situacao_manual"))
        out.append(item)
    return out


def upsert_preventiva(payload: dict[str, Any]) -> dict[str, Any]:
    prefixo = str(payload.get("prefixo") or "").strip()
    tipo = str(payload.get("tipo") or "geral").strip()
    ultima = str(payload.get("ultima_preventiva") or "").strip() or None
    proxima = str(payload.get("proxima_preventiva") or "").strip() or None
    situacao_manual = str(payload.get("situacao_manual") or "").strip().lower() or None
    if not prefixo:
        raise ValueError("prefixo é obrigatório")
    now = _now_iso()
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO preventivas (prefixo, tipo, ultima_preventiva, proxima_preventiva, situacao_manual, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(prefixo) DO UPDATE SET
              tipo=excluded.tipo,
              ultima_preventiva=excluded.ultima_preventiva,
              proxima_preventiva=excluded.proxima_preventiva,
              situacao_manual=excluded.situacao_manual,
              updated_at=excluded.updated_at
            """,
            (prefixo, tipo, ultima, proxima, situacao_manual, now),
        )
        row = conn.execute("SELECT * FROM preventivas WHERE prefixo = ?", (prefixo,)).fetchone()
    item = _row_to_dict(row)
    item["situacao"] = compute_preventiva_situacao(item.get("proxima_preventiva"), item.get("situacao_manual"))
    return item


def compute_preventiva_situacao(proxima_preventiva: Any, situacao_manual: Any) -> str:
    manual = (str(situacao_manual or "").strip().lower() if situacao_manual is not None else "")
    if manual in {"em_dia", "proxima", "vencida"}:
        return manual
    if not proxima_preventiva:
        return "em_dia"
    try:
        d = date.fromisoformat(str(proxima_preventiva))
    except ValueError:
        return "em_dia"
    hoje = date.today()
    if d < hoje:
        return "vencida"
    if d <= (hoje + timedelta(days=max(1, int(Config.LOCALIZACAO_PREVENTIVA_PROXIMA_DIAS)))):
        return "proxima"
    return "em_dia"


def contexto_por_prefixos(prefixos: list[str]) -> dict[str, dict[str, Any]]:
    if not prefixos:
        return {}
    uniq = sorted({str(p).strip() for p in prefixos if str(p).strip()})
    if not uniq:
        return {}
    qmarks = ",".join(["?"] * len(uniq))
    out: dict[str, dict[str, Any]] = {p: {"os_abertas": [], "preventiva": None} for p in uniq}
    with _conn() as conn:
        os_rows = conn.execute(
            f"""
            SELECT *
            FROM ordens_servico
            WHERE prefixo IN ({qmarks})
              AND situacao IN ('aberta', 'em_atendimento', 'aguardando_recolhimento')
            ORDER BY data_abertura DESC, id DESC
            """,
            uniq,
        ).fetchall()
        prev_rows = conn.execute(f"SELECT * FROM preventivas WHERE prefixo IN ({qmarks})", uniq).fetchall()
    for r in os_rows:
        item = _row_to_dict(r)
        out[item["prefixo"]]["os_abertas"].append(item)
    for r in prev_rows:
        item = _row_to_dict(r)
        item["situacao"] = compute_preventiva_situacao(item.get("proxima_preventiva"), item.get("situacao_manual"))
        out[item["prefixo"]]["preventiva"] = item
    return out


def _today_iso() -> str:
    return date.today().isoformat()


def contexto_ssov_por_prefixos(prefixos: list[str]) -> dict[str, dict[str, Any]]:
    """Enriquecimento SSOV: preventiva do dia (agenda) e recolhimento ativo."""
    base = contexto_por_prefixos(prefixos)
    uniq = sorted({str(p).strip() for p in prefixos if str(p).strip()})
    if not uniq:
        return base
    hoje = _today_iso()
    qmarks = ",".join(["?"] * len(uniq))
    with _conn() as conn:
        rec_rows = conn.execute(
            f"""
            SELECT * FROM recolhimentos
            WHERE prefixo IN ({qmarks})
              AND status IN ('aguardando', 'em_deslocamento')
            ORDER BY id DESC
            """,
            uniq,
        ).fetchall()
        pa_rows = conn.execute(
            f"""
            SELECT * FROM preventivas_agenda
            WHERE prefixo IN ({qmarks})
              AND data_preventiva = ?
              AND status IN ('pendente', 'no_mapa', 'chegou')
            ORDER BY id DESC
            """,
            (*uniq, hoje),
        ).fetchall()
    rec_by_pfx: dict[str, dict[str, Any]] = {}
    for r in rec_rows:
        item = _row_to_dict(r)
        pfx = str(item.get("prefixo") or "").strip()
        if pfx and pfx not in rec_by_pfx:
            rec_by_pfx[pfx] = item
    pa_by_pfx: dict[str, dict[str, Any]] = {}
    for r in pa_rows:
        item = _row_to_dict(r)
        pfx = str(item.get("prefixo") or "").strip()
        if pfx and pfx not in pa_by_pfx:
            pa_by_pfx[pfx] = item
    for p in uniq:
        if p not in base:
            base[p] = {"os_abertas": [], "preventiva": None}
        base[p]["recolhimento_ativo"] = rec_by_pfx.get(p)
        base[p]["preventiva_agenda_hoje"] = pa_by_pfx.get(p)
        base[p]["ssov_recolhimento_ativo"] = p in rec_by_pfx
        base[p]["ssov_preventiva_hoje"] = p in pa_by_pfx
    return base


def list_preventivas_agenda(
    *,
    prefixo: str | None = None,
    data: str | None = None,
    status: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM preventivas_agenda WHERE 1=1"
    args: list[Any] = []
    if prefixo:
        sql += " AND prefixo = ?"
        args.append(prefixo.strip())
    if data:
        sql += " AND data_preventiva = ?"
        args.append(str(data).strip())
    if status:
        sql += " AND status = ?"
        args.append(str(status).strip().lower())
    sql += " ORDER BY data_preventiva DESC, id DESC"
    with _conn() as conn:
        return [_row_to_dict(r) for r in conn.execute(sql, args).fetchall()]


def create_preventiva_agenda(payload: dict[str, Any], usuario: str | None = None) -> dict[str, Any]:
    prefixo = str(payload.get("prefixo") or "").strip()
    data_prev = str(payload.get("data_preventiva") or "").strip()
    tipo = str(payload.get("tipo") or "geral").strip()
    observacao = str(payload.get("observacao") or "").strip() or None
    status = str(payload.get("status") or "pendente").strip().lower()
    if not prefixo or not data_prev:
        raise ValueError("prefixo e data_preventiva são obrigatórios")
    if status not in {"pendente", "no_mapa", "chegou", "baixado", "cancelado"}:
        raise ValueError("status inválido")
    now = _now_iso()
    with _conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO preventivas_agenda (
              prefixo, data_preventiva, tipo, observacao, status,
              usuario_criacao, data_criacao, usuario_baixa, data_baixa
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
            """,
            (prefixo, data_prev, tipo, observacao, status, usuario or "sistema", now),
        )
        rid = int(cur.lastrowid)
        row = conn.execute("SELECT * FROM preventivas_agenda WHERE id = ?", (rid,)).fetchone()
        return _row_to_dict(row)


def baixa_preventiva_agenda(agenda_id: int, usuario: str | None = None) -> dict[str, Any] | None:
    now = _now_iso()
    with _conn() as conn:
        conn.execute(
            """
            UPDATE preventivas_agenda
            SET status = 'baixado', usuario_baixa = ?, data_baixa = ?
            WHERE id = ? AND status NOT IN ('baixado', 'cancelado')
            """,
            (usuario or "sistema", now, agenda_id),
        )
        row = conn.execute("SELECT * FROM preventivas_agenda WHERE id = ?", (agenda_id,)).fetchone()
        return _row_to_dict(row) if row else None


def cancelar_preventiva_agenda(agenda_id: int, usuario: str | None = None) -> dict[str, Any] | None:
    with _conn() as conn:
        conn.execute(
            """
            UPDATE preventivas_agenda
            SET status = 'cancelado', usuario_baixa = ?, data_baixa = ?
            WHERE id = ? AND status NOT IN ('baixado', 'cancelado')
            """,
            (usuario or "sistema", _now_iso(), agenda_id),
        )
        row = conn.execute("SELECT * FROM preventivas_agenda WHERE id = ?", (agenda_id,)).fetchone()
        return _row_to_dict(row) if row else None


def list_recolhimentos(prefixo: str | None = None, status: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM recolhimentos WHERE 1=1"
    args: list[Any] = []
    if prefixo:
        sql += " AND prefixo = ?"
        args.append(prefixo.strip())
    if status:
        sql += " AND status = ?"
        args.append(status.strip().lower())
    sql += " ORDER BY id DESC"
    with _conn() as conn:
        return [_row_to_dict(r) for r in conn.execute(sql, args).fetchall()]


def create_recolhimento(payload: dict[str, Any], usuario: str | None = None) -> dict[str, Any]:
    prefixo = str(payload.get("prefixo") or "").strip()
    motivo = str(payload.get("motivo") or "").strip()
    solicitante = str(payload.get("solicitante") or "").strip() or None
    observacao = str(payload.get("observacao") or "").strip() or None
    st = str(payload.get("status") or "aguardando").strip().lower()
    if not prefixo or not motivo:
        raise ValueError("prefixo e motivo são obrigatórios")
    if st not in {"aguardando", "em_deslocamento", "recolhido", "cancelado"}:
        raise ValueError("status inválido")
    now = _now_iso()
    with _conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO recolhimentos (
              prefixo, motivo, status, solicitante, observacao,
              usuario_criacao, data_criacao, data_finalizacao
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (prefixo, motivo, st, solicitante, observacao, usuario or "sistema", now),
        )
        rid = int(cur.lastrowid)
        row = conn.execute("SELECT * FROM recolhimentos WHERE id = ?", (rid,)).fetchone()
        return _row_to_dict(row)


def update_recolhimento_status(rec_id: int, status: str, usuario: str | None = None) -> dict[str, Any] | None:
    st = str(status or "").strip().lower()
    if st not in {"aguardando", "em_deslocamento", "recolhido", "cancelado"}:
        raise ValueError("status inválido")
    now_fin = _now_iso()
    with _conn() as conn:
        if st in {"recolhido", "cancelado"}:
            conn.execute(
                "UPDATE recolhimentos SET status = ?, data_finalizacao = ? WHERE id = ?",
                (st, now_fin, rec_id),
            )
        else:
            conn.execute("UPDATE recolhimentos SET status = ? WHERE id = ?", (st, rec_id))
        row = conn.execute("SELECT * FROM recolhimentos WHERE id = ?", (rec_id,)).fetchone()
        return _row_to_dict(row) if row else None


def registrar_acao(prefixo: str, tipo_acao: str, descricao: str | None, usuario: str | None) -> dict[str, Any]:
    if not str(prefixo or "").strip():
        raise ValueError("prefixo é obrigatório")
    now = _now_iso()
    with _conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO acoes_operacionais (prefixo, tipo_acao, descricao, usuario, data_hora)
            VALUES (?, ?, ?, ?, ?)
            """,
            (str(prefixo).strip(), str(tipo_acao).strip(), (descricao or "").strip() or None, usuario, now),
        )
        rid = int(cur.lastrowid)
        row = conn.execute("SELECT * FROM acoes_operacionais WHERE id = ?", (rid,)).fetchone()
        return _row_to_dict(row)


def list_acoes(limit: int = 200) -> list[dict[str, Any]]:
    n = max(1, min(500, int(limit)))
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM acoes_operacionais ORDER BY id DESC LIMIT ?",
            (n,),
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def ensure_default_admin() -> None:
    from werkzeug.security import generate_password_hash

    with _conn() as conn:
        n = conn.execute("SELECT COUNT(*) AS c FROM usuarios").fetchone()
        if n and int(n["c"]) > 0:
            return
        raw_pw = str(getattr(Config, "SSOV_DEFAULT_ADMIN_PASSWORD", None) or "admin").strip()
        h = generate_password_hash(raw_pw)
        conn.execute(
            """
            INSERT INTO usuarios (nome, login, senha_hash, perfil, ativo, data_criacao)
            VALUES ('Administrador', 'admin', ?, 'admin', 1, ?)
            """,
            (h, _now_iso()),
        )


def get_usuario_por_login(login: str) -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM usuarios WHERE login = ? AND ativo = 1", (login.strip(),)).fetchone()
        return _row_to_dict(row) if row else None


def list_usuarios() -> list[dict[str, Any]]:
    with _conn() as conn:
        rows = conn.execute("SELECT id, nome, login, perfil, ativo, data_criacao FROM usuarios ORDER BY login").fetchall()
        return [_row_to_dict(r) for r in rows]
