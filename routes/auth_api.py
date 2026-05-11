from __future__ import annotations

from functools import wraps

from flask import Blueprint, jsonify, request, session
from werkzeug.security import check_password_hash

from config import Config
from services.manutencao_local import get_usuario_por_login

bp_auth = Blueprint("auth_api", __name__, url_prefix="/api/auth")


def acesso_livre_habilitado() -> bool:
    return bool(getattr(Config, "SSOV_ACESSO_LIVRE", True))


def auth_policy_payload() -> dict[str, bool]:
    return {"acesso_livre": acesso_livre_habilitado()}


@bp_auth.route("/login", methods=["POST"])
def auth_login():
    data = request.get_json(silent=True) or {}
    login_name = str(data.get("login") or "").strip()
    senha = str(data.get("senha") or "")
    u = get_usuario_por_login(login_name)
    if not u or not check_password_hash(str(u.get("senha_hash") or ""), senha):
        return jsonify({"ok": False, "erro": "Credenciais inválidas"}), 401
    session["uid"] = u["id"]
    session["login"] = u["login"]
    session["perfil"] = str(u.get("perfil") or "").lower()
    session["nome"] = u["nome"]
    return jsonify(
        {
            "ok": True,
            "usuario": {
                "nome": u["nome"],
                "login": u["login"],
                "perfil": session["perfil"],
            },
        }
    )


@bp_auth.route("/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"ok": True})


@bp_auth.route("/me")
def auth_me():
    if not session.get("uid"):
        return jsonify({"ok": True, "autenticado": False, "usuario": None, **auth_policy_payload()})
    return jsonify(
        {
            "ok": True,
            "autenticado": True,
            "usuario": {
                "nome": session.get("nome"),
                "login": session.get("login"),
                "perfil": session.get("perfil"),
            },
            **auth_policy_payload(),
        }
    )


def require_login():
    from flask import session as sess

    if acesso_livre_habilitado():
        return None
    if not sess.get("uid"):
        return jsonify({"ok": False, "erro": "Não autenticado"}), 401
    return None


def require_operador():
    """Apenas `admin` e `operador` podem alterar dados operacionais (POST/PUT).

    Perfis como `visualizador`, `gerente` ou `diretor` na tabela `usuarios`
    continuam autenticados para leitura, mas recebem 403 nas rotas que usam `_guard_escrita()`.
    """
    from flask import session as sess

    if acesso_livre_habilitado():
        return None
    p = str(sess.get("perfil") or "").lower()
    if p not in ("admin", "operador"):
        return jsonify({"ok": False, "erro": "Sem permissão para esta ação"}), 403
    return None


def require_admin():
    from flask import session as sess

    if acesso_livre_habilitado():
        return None
    if str(sess.get("perfil") or "").lower() != "admin":
        return jsonify({"ok": False, "erro": "Apenas administrador"}), 403
    return None


def operador_or_read(fn):
    @wraps(fn)
    def w(*args, **kwargs):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            err = require_login()
            if err:
                return err
            err = require_operador()
            if err:
                return err
        return fn(*args, **kwargs)

    return w
