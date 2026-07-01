"""tortoise-orm CRUD surface."""

from tortoise import fields
from tortoise.models import Model


class User(Model):
    id = fields.IntField(pk=True)
    name = fields.CharField(max_length=100)
    age = fields.IntField()


class Order(Model):
    id = fields.IntField(pk=True)
    total = fields.IntField()


async def create_user():
    return await User.create(name='alice', age=30)


async def list_users():
    return await User.all()


async def filter_users():
    return await User.filter(name='alice').all()


async def get_user(uid: int):
    return await User.get(id=uid)


async def get_or_none_user(uid: int):
    return await User.get_or_none(id=uid)


async def update_user():
    return await User.filter(id=1).update(age=31)


async def delete_user():
    return await User.filter(id=1).delete()


async def count_users():
    return await User.all().count()


async def create_order(total: int):
    return await Order.create(total=total)


async def filter_orders():
    return await Order.filter(total__gt=100).all()
