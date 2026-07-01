# Blueprint with url_prefix declared but no register_blueprint call in
# this file. Routes should pick up only the blueprint_prefix.
from flask import Blueprint

bp = Blueprint("api", __name__, url_prefix="/items")


@bp.route("/<int:id>")
def get_item(id):
    return {"id": id}


@bp.route("/<int:id>", methods=["DELETE"])
def delete_item(id):
    return {}
