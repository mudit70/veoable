"""Elasticsearch python client."""

from elasticsearch import Elasticsearch

es = Elasticsearch("http://localhost:9200")


def index_user(name: str):
    return es.index(index="users", document={"name": name})


def search_users(query: str):
    return es.search(index="users", body={"query": {"match": {"name": query}}})


def get_user(id: str):
    return es.get(index="users", id=id)


def delete_user(id: str):
    return es.delete(index="users", id=id)


def update_user(id: str, name: str):
    return es.update(index="users", id=id, body={"doc": {"name": name}})


def count_orders():
    return es.count(index="orders")


def exists_audit(id: str):
    return es.exists(index="audit-log", id=id)


def dynamic_index(idx: str):
    # Dynamic — no literal index → no emit.
    return es.search(index=idx, body={"query": {"match_all": {}}})
