from flask import Flask

app = Flask(__name__)


@app.route("/health")
def health():
    return {"ok": True}


@app.get("/version")
def version():
    return {"version": 1}


@app.route("/login", methods=["POST"])
def login():
    return {}
