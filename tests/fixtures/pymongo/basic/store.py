"""Fixture for framework-pymongo."""

from pymongo import MongoClient

client = MongoClient('mongodb://localhost:27017')
db = client['mydb']
users = db['users']            # bracket form
orders = db.orders             # attribute form
products = client['mydb']['products']  # nested subscript


def list_users():
    return list(users.find({}))


def get_user(user_id):
    return users.find_one({'_id': user_id})


def count_active_users():
    return users.count_documents({'active': True})


def create_user(name):
    users.insert_one({'name': name})


def create_many(docs):
    users.insert_many(docs)


def update_user(uid, name):
    users.update_one({'_id': uid}, {'$set': {'name': name}})


def deactivate_all():
    users.update_many({}, {'$set': {'active': False}})


def replace_user(uid, doc):
    users.replace_one({'_id': uid}, doc)


def delete_user(uid):
    users.delete_one({'_id': uid})


def delete_expired():
    users.delete_many({'expires_at': {'$lt': 0}})


def aggregate_user_stats():
    return list(users.aggregate([{'$group': {'_id': '$status'}}]))


def find_and_modify_order(order_id):
    return orders.find_one_and_update(
        {'_id': order_id},
        {'$set': {'status': 'paid'}},
    )


def list_orders():
    return list(orders.find({}))


def list_products_via_nested():
    return list(products.find({}))


# ── Attribute-form on db (not via a bound variable) ─────────────
def direct_db_attribute():
    return db.events.find_one({'kind': 'click'})


def direct_db_bracket():
    return db['events'].insert_one({'kind': 'view'})


# ── self.<coll> binding pattern inside a class ──────────────────
class OrderRepo:
    def __init__(self, db):
        self.orders = db['orders']

    def find_one(self, oid):
        return self.orders.find_one({'_id': oid})


# ── Negative: a dict.find() / list.find() lookalike ─────────────
def unrelated_find():
    s = "hello"
    return s.find("ell")


# ── Negative: db.aggregate(...) is a DATABASE method, not a
# Collection method. Pre-fix the binding scanner mapped `db` →
# 'mydb' (because `db = client['mydb']`), causing a phantom 'mydb'
# collection emit for db.aggregate calls. Two-pass fix marks `db`
# as a database, so the collection-RHS scan skips it.
def db_aggregate_must_not_emit():
    return list(db.aggregate([{'$listLocalSessions': {}}]))
