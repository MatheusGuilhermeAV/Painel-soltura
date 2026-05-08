from flask import render_template

from routes import bp_dashboard


@bp_dashboard.route("/")
def index():
    return render_template("dashboard.html")
