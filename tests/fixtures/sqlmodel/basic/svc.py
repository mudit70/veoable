"""SQLModel CRUD surface."""

from typing import Optional
from sqlmodel import Field, Session, SQLModel, select


class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    age: int


class Team(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str


def add_hero(session: Session):
    hero = Hero(name='alice', age=30)
    session.add(hero)
    session.commit()


def merge_hero(session: Session):
    session.merge(Hero(id=1, name='bob', age=31))


def get_hero(session: Session, hid: int):
    return session.get(Hero, hid)


def list_heroes(session: Session):
    return session.exec(select(Hero)).all()


def find_heroes(session: Session):
    return session.exec(select(Hero).where(Hero.age > 18)).all()


def add_team(session: Session):
    session.add(Team(name='Avengers'))


def list_teams(session: Session):
    return session.exec(select(Team)).all()
