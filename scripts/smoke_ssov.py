"""Fumo: importa a app Flask e valida GET /api/health (sem MySQL obrigatório para import)."""
from __future__ import annotations

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def main() -> int:
    from app import create_app

    app = create_app()
    client = app.test_client()
    r = client.get("/api/health")
    if r.status_code != 200:
        print("FAIL: /api/health status", r.status_code, file=sys.stderr)
        return 1
    data = r.get_json(silent=True) or {}
    if not data.get("ok"):
        print("FAIL: /api/health body ok=false", data, file=sys.stderr)
        return 1
    print("OK: create_app + /api/health")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
