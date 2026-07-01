from flask import Flask, jsonify, request

app = Flask(__name__)

notes = []

@app.get("/api/notes")
def list_notes():
    return jsonify(notes)

@app.post("/api/notes")
def create_note():
    data = request.get_json()
    note = {"id": len(notes) + 1, "title": data["title"], "body": data.get("body", "")}
    notes.append(note)
    return jsonify(note), 201

@app.get("/api/notes/<int:note_id>")
def get_note(note_id):
    note = next((n for n in notes if n["id"] == note_id), None)
    if not note:
        return jsonify({"error": "not found"}), 404
    return jsonify(note)

@app.delete("/api/notes/<int:note_id>")
def delete_note(note_id):
    global notes
    notes = [n for n in notes if n["id"] != note_id]
    return "", 204

@app.route("/api/notes/<int:note_id>", methods=["PUT"])
def update_note(note_id):
    data = request.get_json()
    for note in notes:
        if note["id"] == note_id:
            note["title"] = data.get("title", note["title"])
            note["body"] = data.get("body", note["body"])
            return jsonify(note)
    return jsonify({"error": "not found"}), 404
