from __future__ import annotations

from csv import DictWriter
from io import BytesIO, StringIO
from typing import Any, Callable, Mapping

from flask import Response

from services import manutencao_local, veiculos

ReportFetcher = Callable[[Mapping[str, str | None]], list[dict[str, Any]]]

QUEBRAS_COLUMNS = [
    "id",
    "prefixo",
    "linha",
    "motorista",
    "motivo",
    "descricao",
    "status",
    "os_id",
    "usuario_criacao",
    "data_criacao",
    "data_encerramento",
]

LOCALIZACAO_COLUMNS = [
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

FROTA_COLUMNS = [
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

REPORT_SPECS: dict[str, dict[str, Any]] = {
    "quebras": {
        "title": "Quebras operacionais",
        "filename_stem": "quebras_operacionais",
        "columns": QUEBRAS_COLUMNS,
    },
    "localizacao": {
        "title": "Carros para localizar",
        "filename_stem": "carros_para_localizar",
        "columns": LOCALIZACAO_COLUMNS,
    },
    "frota": {
        "title": "Frota completa",
        "filename_stem": "frota_completa",
        "columns": FROTA_COLUMNS,
    },
}


def normalize_formato(raw: str | None) -> str:
    fmt = (raw or "csv").strip().lower()
    if fmt in ("csv",):
        return "csv"
    if fmt in ("xlsx", "excel"):
        return "xlsx"
    if fmt in ("pdf",):
        return "pdf"
    raise ValueError("Formato inválido. Use csv, xlsx ou pdf.")


def serialize_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "sim" if value else "nao"
    return str(value)


def _query_arg(params: Mapping[str, str | None], key: str) -> str | None:
    raw = params.get(key)
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def fetch_quebras_items(params: Mapping[str, str | None]) -> list[dict[str, Any]]:
    return list(
        manutencao_local.list_quebras(
            prefixo=_query_arg(params, "prefixo"),
            status=_query_arg(params, "status"),
            motivo=_query_arg(params, "motivo"),
            de=_query_arg(params, "de"),
            ate=_query_arg(params, "ate"),
        )
    )


def fetch_localizacao_items(_params: Mapping[str, str | None]) -> list[dict[str, Any]]:
    data = veiculos.list_carros_para_localizar()
    return list(data.get("veiculos") or [])


def fetch_frota_items(_params: Mapping[str, str | None]) -> list[dict[str, Any]]:
    data = veiculos.list_fleet_bundle()
    return list(data.get("veiculos") or [])


FETCHERS: dict[str, ReportFetcher] = {
    "quebras": fetch_quebras_items,
    "localizacao": fetch_localizacao_items,
    "frota": fetch_frota_items,
}


def render_csv(columns: list[str], items: list[dict[str, Any]]) -> str:
    buff = StringIO()
    wr = DictWriter(buff, fieldnames=columns)
    wr.writeheader()
    for item in items:
        wr.writerow({col: serialize_cell(item.get(col)) for col in columns})
    return buff.getvalue()


def render_xlsx(columns: list[str], items: list[dict[str, Any]], sheet_title: str) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = sheet_title[:31]
    ws.append(columns)
    for item in items:
        ws.append([serialize_cell(item.get(col)) for col in columns])
    buff = BytesIO()
    wb.save(buff)
    return buff.getvalue()


def render_pdf(columns: list[str], items: list[dict[str, Any]], title: str) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buff = BytesIO()
    page_size = landscape(A4) if len(columns) > 6 else A4
    doc = SimpleDocTemplate(buff, pagesize=page_size, leftMargin=28, rightMargin=28, topMargin=36, bottomMargin=28)
    styles = getSampleStyleSheet()
    heading = ParagraphStyle(
        "ReportHeading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=12,
        spaceAfter=10,
    )
    table_data = [columns] + [[serialize_cell(item.get(col)) for col in columns] for item in items]
    table = Table(table_data, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#009639")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 7),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cbd5e1")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    story = [Paragraph(title, heading), Spacer(1, 6), table]
    doc.build(story)
    return buff.getvalue()


def build_export_response(report_id: str, formato: str, params: Mapping[str, str | None]) -> Response:
    spec = REPORT_SPECS.get(report_id)
    fetcher = FETCHERS.get(report_id)
    if not spec or not fetcher:
        raise KeyError(f"Relatório desconhecido: {report_id}")

    fmt = normalize_formato(formato)
    columns = list(spec["columns"])
    items = fetcher(params)
    stem = str(spec["filename_stem"])
    title = str(spec["title"])

    if fmt == "csv":
        payload: str | bytes = render_csv(columns, items)
        mimetype = "text/csv; charset=utf-8"
        filename = f"{stem}.csv"
    elif fmt == "xlsx":
        payload = render_xlsx(columns, items, title)
        mimetype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        filename = f"{stem}.xlsx"
    else:
        payload = render_pdf(columns, items, title)
        mimetype = "application/pdf"
        filename = f"{stem}.pdf"

    return Response(
        payload,
        mimetype=mimetype,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
