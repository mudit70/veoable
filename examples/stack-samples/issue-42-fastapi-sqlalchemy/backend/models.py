# SQLAlchemy models — patterns a framework-sqlalchemy visitor must detect
#
# Detection targets:
#   - @Entity equivalent: class Task(Base) with __tablename__
#   - Column definitions: Column(String), Column(Integer)
#   - Relationships: relationship("User")

from sqlalchemy import Column, Integer, String, ForeignKey, Enum
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    name = Column(String)
    tasks = relationship("Task", back_populates="owner")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, index=True)
    status = Column(Enum("todo", "in_progress", "done"), default="todo")
    owner_id = Column(Integer, ForeignKey("users.id"))
    owner = relationship("User", back_populates="tasks")
