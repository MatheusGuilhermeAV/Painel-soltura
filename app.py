from flask import Flask

from config import Config
from routes import bp_api, bp_dashboard
from services.manutencao_local import ensure_default_admin, init_db


def create_app() -> Flask:
    app = Flask(__name__)
    app.config.from_object(Config)
    init_db()
    ensure_default_admin()

    # Registra views nos blueprints
    from routes import api as _api  # noqa: F401
    from routes import auth_api as _auth_api  # noqa: F401
    from routes import dashboard as _dash  # noqa: F401

    app.register_blueprint(bp_dashboard)
    app.register_blueprint(bp_api)
    app.register_blueprint(_auth_api.bp_auth)

    return app


app = create_app()


if __name__ == "__main__":
    print("\n  Painel Soltura — http://127.0.0.1:5000  (tambem na rede: porta 5000)\n")
    app.run(host="0.0.0.0", port=5000, debug=True)
