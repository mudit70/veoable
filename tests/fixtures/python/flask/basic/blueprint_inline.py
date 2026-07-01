from flask import Flask, Blueprint

app = Flask(__name__)

bp = Blueprint("users", __name__, url_prefix="/users")


@bp.route("/<int:id>")
def get_user(id):
    return {"id": id}


@bp.get("/<int:id>/posts")
def list_user_posts(id):
    return []


@bp.route("/", methods=["GET", "POST"])
def list_or_create():
    return []


# Mount the blueprint at /api → all routes get /api prepended.
app.register_blueprint(bp, url_prefix="/api")


# Plain app routes — should NOT pick up the /api prefix.
@app.route("/version")
def version():
    return {"version": 1}
