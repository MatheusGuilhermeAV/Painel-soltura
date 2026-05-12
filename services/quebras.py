from __future__ import annotations

import csv
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Any

from services.manutencao_local import _conn, _now_iso, _row_to_dict, registrar_acao

STATUS_ABERTA = "aberta"
STATUS_EM_SOCORRO = "em_socorro"
STATUS_AGUARDANDO = "aguardando_avaliacao"
STATUS_RECOLHIDO = "recolhido"
STATUS_LIBERADO = "liberado"
STATUS_FINALIZADO = "finalizado"
STATUS_CANCELADO = "cancelado"

STATUS_ATIVOS = frozenset(
    {
        STATUS_ABERTA,
        "ativa",
        STATUS_EM_SOCORRO,
        STATUS_AGUARDANDO,
        STATUS_RECOLHIDO,
        STATUS_LIBERADO,
    }
)
STATUS_MAPA = frozenset({STATUS_ABERTA, "ativa", STATUS_EM_SOCORRO, STATUS_AGUARDANDO})
STATUS_TERMINAIS = frozenset({STATUS_FINALIZADO, STATUS_CANCELADO, "encerrada"})

STATUS_LABELS = {
    STATUS_ABERTA: "Quebra aberta",
    "ativa": "Quebra aberta",
    STATUS_EM_SOCORRO: "Em socorro",
    STATUS_AGUARDANDO: "Aguardando avaliação",
    STATUS_RECOLHIDO: "Recolhido",
    STATUS_LIBERADO: "Liberado",
    STATUS_FINALIZADO: "Finalizado",
    STATUS_CANCELADO: "Cancelado",
    "encerrada": "Finalizado",
}


def _catalog_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "catalogos"


def normalize_status(raw: str | None) -> str:
    s = str(raw or "").strip().lower()
    if s == "ativa":
        return STATUS_ABERTA
    if s == "encerrada":
        return STATUS_FINALIZADO
    return s or STATUS_ABERTA


def status_label(raw: str | None) -> str:
    return STATUS_LABELS.get(normalize_status(raw), normalize_status(raw))


def _quebra_public(row: dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    item["status"] = normalize_status(item.get("status"))
    item["status_label"] = status_label(item.get("status"))
    item["socorro_enviado"] = bool(item.get("socorro_enviado"))
    defeito = str(item.get("defeito_descricao") or item.get("defeito") or item.get("motivo") or "").strip()
    setor = str(item.get("setor_responsavel") or item.get("grupo_descricao") or "").strip()
    item["defeito"] = defeito or None
    item["defeito_descricao"] = defeito or None
    item["setor_responsavel"] = setor or None
    item["grupo_descricao"] = setor or None
    return item


def _defeito_catalog_public(row: dict[str, Any]) -> dict[str, Any]:
    item = _row_to_dict(row)
    setor = str(item.get("setor_responsavel") or item.get("grupo_descricao") or "").strip()
    defeito = str(item.get("descricao") or "").strip()
    item["setor_responsavel"] = setor or None
    item["defeito"] = defeito or None
    item["codigo"] = str(item.get("codigo") or "").strip() or None
    item["ativo"] = bool(item.get("ativo", 1))
    return item


def init_quebras_tables() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS grupos_servico (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                codigo TEXT NOT NULL UNIQUE,
                descricao TEXT NOT NULL,
                ativo INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS defeitos_catalogo (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                codigo TEXT NOT NULL,
                descricao TEXT NOT NULL,
                grupo_codigo TEXT NOT NULL,
                grupo_descricao TEXT,
                setor_responsavel TEXT,
                ativo INTEGER NOT NULL DEFAULT 1,
                UNIQUE(codigo, grupo_codigo)
            );
            """
        )
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(quebras_operacionais)").fetchall()}
        migrations = {
            "defeito_codigo": "TEXT",
            "defeito_descricao": "TEXT",
            "grupo_codigo": "TEXT",
            "grupo_descricao": "TEXT",
            "data_ocorrencia": "TEXT",
            "local_ocorrencia": "TEXT",
            "latitude": "REAL",
            "longitude": "REAL",
            "socorro_enviado": "INTEGER NOT NULL DEFAULT 0",
            "observacao": "TEXT",
            "usuario_finalizacao": "TEXT",
            "data_finalizacao": "TEXT",
            "recolhimento_id": "INTEGER",
            "setor_responsavel": "TEXT",
        }
        for name, col_type in migrations.items():
            if name not in cols:
                conn.execute(f"ALTER TABLE quebras_operacionais ADD COLUMN {name} {col_type}")
        defeito_cols = {r["name"] for r in conn.execute("PRAGMA table_info(defeitos_catalogo)").fetchall()}
        if "setor_responsavel" not in defeito_cols:
            conn.execute("ALTER TABLE defeitos_catalogo ADD COLUMN setor_responsavel TEXT")
        conn.execute(
            """
            UPDATE quebras_operacionais
            SET status = 'aberta'
            WHERE status = 'ativa'
            """
        )
        conn.execute(
            """
            UPDATE quebras_operacionais
            SET status = 'finalizado'
            WHERE status = 'encerrada'
            """
        )
        conn.execute(
            """
            UPDATE quebras_operacionais
            SET defeito_descricao = COALESCE(defeito_descricao, motivo),
                observacao = COALESCE(observacao, descricao)
            WHERE defeito_descricao IS NULL OR defeito_descricao = ''
            """
        )
        conn.execute(
            """
            UPDATE quebras_operacionais
            SET setor_responsavel = COALESCE(setor_responsavel, grupo_descricao)
            WHERE setor_responsavel IS NULL OR setor_responsavel = ''
            """
        )
        conn.execute(
            """
            UPDATE defeitos_catalogo
            SET setor_responsavel = COALESCE(setor_responsavel, grupo_descricao)
            WHERE setor_responsavel IS NULL OR setor_responsavel = ''
            """
        )
    importar_catalogos_csv()


def _read_csv_rows(path: Path) -> list[list[str]]:
    if not path.is_file():
        return []
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            with path.open("r", encoding=encoding, newline="") as fh:
                return list(csv.reader(fh, delimiter=";"))
        except UnicodeDecodeError:
            continue
    return []


def importar_catalogos_csv() -> dict[str, int]:
    base = _catalog_dir()
    grupos_path = base / "grupos_servico.csv"
    defeitos_path = base / "defeitos_catalogo.csv"
    grupos = 0
    defeitos = 0
    with _conn() as conn:
        for row in _read_csv_rows(grupos_path):
            if len(row) < 2:
                continue
            codigo = str(row[0]).strip()
            descricao = str(row[1]).strip()
            if not codigo or codigo.lower() in {"código", "codigo"}:
                continue
            if not descricao:
                continue
            conn.execute(
                """
                INSERT INTO grupos_servico (codigo, descricao, ativo)
                VALUES (?, ?, 1)
                ON CONFLICT(codigo) DO UPDATE SET
                  descricao = excluded.descricao,
                  ativo = 1
                """,
                (codigo, descricao),
            )
            grupos += 1
        for row in _read_csv_rows(defeitos_path):
            if len(row) < 4:
                continue
            grupo_codigo = str(row[0]).strip()
            grupo_descricao = str(row[1]).strip()
            codigo = str(row[2]).strip()
            descricao = str(row[3]).strip()
            if grupo_codigo.lower() in {"código", "codigo"}:
                continue
            if not grupo_codigo or not codigo or not descricao:
                continue
            conn.execute(
                """
                INSERT INTO defeitos_catalogo (
                  codigo, descricao, grupo_codigo, grupo_descricao, setor_responsavel, ativo
                )
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(codigo, grupo_codigo) DO UPDATE SET
                  descricao = excluded.descricao,
                  grupo_descricao = excluded.grupo_descricao,
                  setor_responsavel = excluded.setor_responsavel,
                  ativo = 1
                """,
                (codigo, descricao, grupo_codigo, grupo_descricao or None, grupo_descricao or None),
            )
            defeitos += 1
    return {"grupos": grupos, "defeitos": defeitos}


def listar_setores_defeito(*, apenas_ativos: bool = True) -> list[dict[str, Any]]:
    sql = """
        SELECT DISTINCT COALESCE(setor_responsavel, grupo_descricao) AS setor_responsavel
        FROM defeitos_catalogo
        WHERE COALESCE(setor_responsavel, grupo_descricao) IS NOT NULL
          AND TRIM(COALESCE(setor_responsavel, grupo_descricao)) != ''
    """
    if apenas_ativos:
        sql += " AND ativo = 1"
    sql += " ORDER BY setor_responsavel COLLATE NOCASE"
    with _conn() as conn:
        rows = conn.execute(sql).fetchall()
    return [{"setor_responsavel": str(r["setor_responsavel"]).strip()} for r in rows if str(r["setor_responsavel"]).strip()]


def listar_grupos_servico(*, apenas_ativos: bool = True) -> list[dict[str, Any]]:
    sql = "SELECT * FROM grupos_servico"
    if apenas_ativos:
        sql += " WHERE ativo = 1"
    sql += " ORDER BY CAST(codigo AS INTEGER), descricao"
    with _conn() as conn:
        return [_row_to_dict(r) for r in conn.execute(sql).fetchall()]


def listar_defeitos_catalogo(
    *,
    setor: str | None = None,
    grupo_codigo: str | None = None,
    apenas_ativos: bool = True,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM defeitos_catalogo WHERE 1=1"
    args: list[Any] = []
    if apenas_ativos:
        sql += " AND ativo = 1"
    if setor:
        sql += " AND LOWER(COALESCE(setor_responsavel, grupo_descricao)) = LOWER(?)"
        args.append(str(setor).strip())
    if grupo_codigo:
        sql += " AND grupo_codigo = ?"
        args.append(str(grupo_codigo).strip())
    sql += " ORDER BY COALESCE(setor_responsavel, grupo_descricao), CAST(codigo AS INTEGER), descricao"
    with _conn() as conn:
        return [_defeito_catalog_public(r) for r in conn.execute(sql, args).fetchall()]


def _catalogo_defeito_existe(setor: str, defeito: str, defeito_codigo: str | None = None) -> dict[str, Any] | None:
    sql = """
        SELECT * FROM defeitos_catalogo
        WHERE ativo = 1
          AND LOWER(COALESCE(setor_responsavel, grupo_descricao)) = LOWER(?)
          AND LOWER(descricao) = LOWER(?)
    """
    args: list[Any] = [setor.strip(), defeito.strip()]
    if defeito_codigo:
        sql += " AND codigo = ?"
        args.append(str(defeito_codigo).strip())
    with _conn() as conn:
        row = conn.execute(sql, args).fetchone()
    return _defeito_catalog_public(row) if row else None


def listar_quebras(
    *,
    prefixo: str | None = None,
    status: str | None = None,
    motivo: str | None = None,
    de: str | None = None,
    ate: str | None = None,
) -> list[dict[str, Any]]:
    sql = "SELECT * FROM quebras_operacionais WHERE 1=1"
    args: list[Any] = []
    if prefixo:
        sql += " AND prefixo = ?"
        args.append(prefixo.strip())
    if status:
        st = normalize_status(status)
        if st == STATUS_ABERTA and status.strip().lower() == "ativa":
            placeholders = ",".join("?" for _ in STATUS_MAPA)
            sql += f" AND status IN ({placeholders})"
            args.extend(sorted(STATUS_MAPA))
        else:
            sql += " AND status = ?"
            args.append(st)
    if motivo:
        sql += " AND (motivo LIKE ? OR defeito_descricao LIKE ?)"
        like = f"%{str(motivo).strip()}%"
        args.extend([like, like])
    if de:
        sql += " AND substr(COALESCE(data_ocorrencia, data_criacao), 1, 10) >= ?"
        args.append(str(de).strip())
    if ate:
        sql += " AND substr(COALESCE(data_ocorrencia, data_criacao), 1, 10) <= ?"
        args.append(str(ate).strip())
    sql += " ORDER BY id DESC"
    with _conn() as conn:
        return [_quebra_public(_row_to_dict(r)) for r in conn.execute(sql, args).fetchall()]


def listar_quebras_abertas(*, prefixo: str | None = None) -> list[dict[str, Any]]:
    placeholders = ",".join("?" for _ in STATUS_MAPA)
    sql = f"SELECT * FROM quebras_operacionais WHERE status IN ({placeholders})"
    args: list[Any] = list(sorted(STATUS_MAPA))
    if prefixo:
        sql += " AND prefixo = ?"
        args.append(prefixo.strip())
    sql += " ORDER BY id DESC"
    with _conn() as conn:
        return [_quebra_public(_row_to_dict(r)) for r in conn.execute(sql, args).fetchall()]


def obter_quebra(qid: int) -> dict[str, Any] | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM quebras_operacionais WHERE id = ?", (int(qid),)).fetchone()
    return _quebra_public(_row_to_dict(row)) if row else None


def obter_quebras_por_prefixo(prefixo: str) -> list[dict[str, Any]]:
    return listar_quebras(prefixo=prefixo)


def _parse_bool(raw: Any) -> bool:
    if isinstance(raw, bool):
        return raw
    return str(raw or "").strip().lower() in {"1", "true", "yes", "on", "sim"}


def criar_quebra(payload: dict[str, Any], usuario: str | None = None) -> dict[str, Any]:
    prefixo = str(payload.get("prefixo") or "").strip()
    if not prefixo:
        raise ValueError("prefixo é obrigatório")

    linha = str(payload.get("linha") or "").strip() or None
    motorista = str(payload.get("motorista") or "").strip() or None
    setor_responsavel = str(
        payload.get("setor_responsavel") or payload.get("grupo_descricao") or ""
    ).strip()
    defeito = str(payload.get("defeito") or payload.get("defeito_descricao") or "").strip()
    defeito_codigo = str(payload.get("defeito_codigo") or "").strip() or None
    descricao = str(payload.get("descricao") or payload.get("observacao") or "").strip() or None
    observacao = descricao
    local_ocorrencia = str(payload.get("local_ocorrencia") or "").strip() or None
    data_ocorrencia = str(payload.get("data_ocorrencia") or "").strip() or _now_iso()
    socorro_enviado = _parse_bool(payload.get("socorro_enviado"))
    status = normalize_status(str(payload.get("status") or STATUS_ABERTA))
    if status not in STATUS_ATIVOS:
        status = STATUS_EM_SOCORRO if socorro_enviado else STATUS_ABERTA

    lat = payload.get("latitude")
    lon = payload.get("longitude")
    try:
        latitude = float(lat) if lat is not None and str(lat).strip() != "" else None
    except (TypeError, ValueError):
        latitude = None
    try:
        longitude = float(lon) if lon is not None and str(lon).strip() != "" else None
    except (TypeError, ValueError):
        longitude = None

    if not setor_responsavel:
        raise ValueError("setor responsável é obrigatório")
    if not defeito:
        raise ValueError("defeito é obrigatório")

    catalogo = _catalogo_defeito_existe(setor_responsavel, defeito, defeito_codigo)
    if not catalogo:
        raise ValueError("defeito inválido para o setor selecionado")

    grupo_codigo = str(catalogo.get("grupo_codigo") or "").strip() or None
    grupo_descricao = setor_responsavel
    defeito_codigo = str(catalogo.get("codigo") or defeito_codigo or "").strip() or None
    defeito_descricao = defeito
    motivo = defeito

    now = _now_iso()
    data_abertura = date.today().isoformat()
    obs_parts: list[str] = []
    if linha:
        obs_parts.append(f"Linha: {linha}")
    if motorista:
        obs_parts.append(f"Motorista: {motorista}")
    if grupo_descricao:
        obs_parts.append(f"Setor: {grupo_descricao}")
    obs_parts.append(f"Defeito: {defeito}")
    if descricao:
        obs_parts.append(f"Descrição: {descricao}")
    observacao_os = " | ".join(obs_parts)

    with _conn() as conn:
        dup = conn.execute(
            f"""
            SELECT id FROM quebras_operacionais
            WHERE prefixo = ? AND status IN ({",".join("?" for _ in STATUS_ATIVOS)})
            """,
            (prefixo, *sorted(STATUS_ATIVOS)),
        ).fetchone()
        if dup:
            raise ValueError(f"Já existe quebra ativa para o prefixo {prefixo}.")

        cur = conn.execute(
            """
            INSERT INTO ordens_servico (
              prefixo, defeito, data_abertura, situacao, prioridade, observacao,
              observacao_encerramento, data_encerramento, created_at, updated_at
            )
            VALUES (?, ?, ?, 'aberta', 'alta', ?, NULL, NULL, ?, ?)
            """,
            (prefixo, motivo, data_abertura, observacao_os, now, now),
        )
        os_id = int(cur.lastrowid)
        cur2 = conn.execute(
            """
            INSERT INTO quebras_operacionais (
              prefixo, linha, motorista, motivo, descricao, os_id, status,
              usuario_criacao, data_criacao, data_encerramento,
              defeito_codigo, defeito_descricao, grupo_codigo, grupo_descricao,
              setor_responsavel, data_ocorrencia, local_ocorrencia, latitude, longitude,
              socorro_enviado, observacao, usuario_finalizacao, data_finalizacao
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
            """,
            (
                prefixo,
                linha,
                motorista,
                motivo,
                descricao or "",
                os_id,
                status,
                usuario or "sistema",
                now,
                defeito_codigo,
                defeito_descricao or motivo,
                grupo_codigo,
                grupo_descricao,
                setor_responsavel,
                data_ocorrencia,
                local_ocorrencia,
                latitude,
                longitude,
                1 if socorro_enviado else 0,
                observacao,
            ),
        )
        qid = int(cur2.lastrowid)
        row = conn.execute("SELECT * FROM quebras_operacionais WHERE id = ?", (qid,)).fetchone()

    item = _quebra_public(_row_to_dict(row))
    registrar_acao(prefixo, "quebra_criada", f"Quebra #{item['id']} — {motivo}", usuario)
    if socorro_enviado or status == STATUS_EM_SOCORRO:
        registrar_acao(prefixo, "socorro_enviado", f"Socorro para quebra #{item['id']}", usuario)
    return item


def atualizar_status_quebra(
    qid: int,
    status: str,
    usuario: str | None = None,
    *,
    observacao: str | None = None,
    criar_recolhimento: bool = False,
) -> dict[str, Any] | None:
    novo = normalize_status(status)
    if novo not in {
        STATUS_ABERTA,
        STATUS_EM_SOCORRO,
        STATUS_AGUARDANDO,
        STATUS_RECOLHIDO,
        STATUS_LIBERADO,
        STATUS_FINALIZADO,
        STATUS_CANCELADO,
    }:
        raise ValueError("status inválido")

    now = _now_iso()
    with _conn() as conn:
        row = conn.execute("SELECT * FROM quebras_operacionais WHERE id = ?", (int(qid),)).fetchone()
        if not row:
            return None
        current = _row_to_dict(row)
        sets = ["status = ?"]
        args: list[Any] = [novo]
        if observacao is not None:
            sets.append("observacao = ?")
            args.append(str(observacao).strip() or None)
        if novo == STATUS_EM_SOCORRO:
            sets.append("socorro_enviado = 1")
        if novo in STATUS_TERMINAIS:
            sets.append("data_finalizacao = ?")
            sets.append("usuario_finalizacao = ?")
            sets.append("data_encerramento = ?")
            args.extend([now, usuario or "sistema", now])
        args.append(int(qid))
        conn.execute(f"UPDATE quebras_operacionais SET {', '.join(sets)} WHERE id = ?", args)
        updated = conn.execute("SELECT * FROM quebras_operacionais WHERE id = ?", (int(qid),)).fetchone()

    item = _quebra_public(_row_to_dict(updated))
    prefixo = str(item.get("prefixo") or "")
    registrar_acao(prefixo, "quebra_status_alterado", f"Quebra #{qid} → {status_label(novo)}", usuario)
    if novo == STATUS_EM_SOCORRO:
        registrar_acao(prefixo, "socorro_enviado", f"Socorro em andamento — quebra #{qid}", usuario)
    if novo == STATUS_RECOLHIDO:
        registrar_acao(prefixo, "quebra_recolhida", f"Quebra #{qid} marcada como recolhida", usuario)
        if criar_recolhimento:
            from services.manutencao_local import create_recolhimento

            rec = create_recolhimento(
                {
                    "prefixo": prefixo,
                    "motivo": f"Recolhimento vinculado à quebra #{qid}",
                    "observacao": observacao or item.get("observacao"),
                },
                usuario=usuario,
            )
            with _conn() as conn:
                conn.execute(
                    "UPDATE quebras_operacionais SET recolhimento_id = ? WHERE id = ?",
                    (rec.get("id"), int(qid)),
                )
            item["recolhimento_id"] = rec.get("id")
    if novo == STATUS_FINALIZADO:
        registrar_acao(prefixo, "quebra_finalizada", f"Quebra #{qid} finalizada", usuario)
    return item


def finalizar_quebra(qid: int, usuario: str | None = None, observacao: str | None = None) -> dict[str, Any] | None:
    return atualizar_status_quebra(
        qid,
        STATUS_FINALIZADO,
        usuario,
        observacao=observacao,
    )


def encerrar_quebras_por_os(os_id: int) -> int:
    now = _now_iso()
    with _conn() as conn:
        cur = conn.execute(
            """
            UPDATE quebras_operacionais
            SET status = ?, data_encerramento = ?, data_finalizacao = ?, usuario_finalizacao = COALESCE(usuario_finalizacao, 'sistema')
            WHERE os_id = ? AND status IN ({})
            """.format(",".join("?" for _ in STATUS_ATIVOS)),
            (STATUS_FINALIZADO, now, now, int(os_id), *sorted(STATUS_ATIVOS)),
        )
        return int(cur.rowcount)


def quebra_ativa_por_prefixos(prefixos: list[str]) -> dict[str, dict[str, Any]]:
    uniq = [str(p).strip() for p in prefixos if str(p).strip()]
    if not uniq:
        return {}
    placeholders = ",".join("?" for _ in uniq)
    status_ph = ",".join("?" for _ in STATUS_ATIVOS)
    with _conn() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM quebras_operacionais
            WHERE prefixo IN ({placeholders}) AND status IN ({status_ph})
            ORDER BY id DESC
            """,
            (*uniq, *sorted(STATUS_ATIVOS)),
        ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = _quebra_public(_row_to_dict(row))
        pfx = str(item.get("prefixo") or "").strip()
        if pfx and pfx not in out:
            out[pfx] = item
    return out


def inject_vehicle_quebra_fields(vehicle: dict[str, Any], ctx: dict[str, Any] | None) -> None:
    qb = (ctx or {}).get("quebra_ativa")
    if not isinstance(qb, dict) or not qb:
        vehicle["ssov_quebra_aberta"] = False
        vehicle["ssov_quebra_status"] = None
        vehicle["ssov_quebra_defeito"] = None
        vehicle["ssov_quebra_grupo"] = None
        vehicle["ssov_quebra_setor"] = None
        vehicle["ssov_quebra_observacao"] = None
        vehicle["ssov_quebra_socorro_enviado"] = False
        vehicle["ssov_quebra_id"] = None
        return
    qb = _quebra_public(qb)
    st = normalize_status(qb.get("status"))
    vehicle["ssov_quebra_aberta"] = st not in STATUS_TERMINAIS
    vehicle["ssov_quebra_status"] = st
    vehicle["ssov_quebra_defeito"] = qb.get("defeito") or qb.get("defeito_descricao") or qb.get("motivo")
    vehicle["ssov_quebra_setor"] = qb.get("setor_responsavel") or qb.get("grupo_descricao")
    vehicle["ssov_quebra_grupo"] = vehicle["ssov_quebra_setor"]
    vehicle["ssov_quebra_observacao"] = qb.get("observacao") or qb.get("descricao")
    vehicle["ssov_quebra_socorro_enviado"] = bool(qb.get("socorro_enviado")) or st == STATUS_EM_SOCORRO
    vehicle["ssov_quebra_id"] = qb.get("id")
