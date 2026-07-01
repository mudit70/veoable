"""peewee CRUD surface."""

from peewee import Model, CharField, IntegerField, SqliteDatabase

db = SqliteDatabase('app.db')


class User(Model):
    name = CharField()
    age = IntegerField()

    class Meta:
        database = db


class Order(Model):
    total = IntegerField()

    class Meta:
        database = db


def create_user():
    return User.create(name='alice', age=30)


def list_users():
    return User.select()


def get_user(uid: int):
    return User.get(User.id == uid)


def get_or_none_user(uid: int):
    return User.get_or_none(User.id == uid)


def update_user():
    return User.update(age=31).where(User.id == 1).execute()


def delete_user():
    return User.delete().where(User.id == 1).execute()


def create_order(total: int):
    return Order.create(total=total)


def list_orders():
    return Order.select()
