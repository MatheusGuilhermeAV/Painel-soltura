from flask import Blueprint

bp_dashboard = Blueprint("dashboard", __name__)
bp_api = Blueprint("api", __name__, url_prefix="/api")
