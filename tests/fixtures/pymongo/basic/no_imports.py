"""Negative: no pymongo import. Visitor must not fire."""


class FakeColl:
    def find_one(self, q):
        return None


def looks_like_pymongo_but_isnt():
    coll = FakeColl()
    return coll.find_one({'_id': 1})
