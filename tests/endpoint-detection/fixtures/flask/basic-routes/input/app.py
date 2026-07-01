from flask import Flask
app = Flask(__name__)

@app.route('/users', methods=['GET'])
def list_users():
    return []

@app.get('/users/<int:id>')
def get_user(id):
    return {}

@app.post('/users')
def create_user():
    return {}, 201

@app.delete('/users/<int:id>')
def delete_user(id):
    return '', 204
