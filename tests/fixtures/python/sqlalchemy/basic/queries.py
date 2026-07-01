from models import User, Task


def list_users(db):
    """db.query(User).all() — read on `user`."""
    return db.query(User).all()


def get_user(db, user_id):
    """db.query(User).get(user_id) — read."""
    return db.query(User).get(user_id)


def list_tasks_filtered(db, owner_id):
    """db.query(Task).filter(...) — read on `task`."""
    return db.query(Task).filter(Task.owner_id == owner_id).all()


def create_user(db, email):
    """db.add(...) — write on `user`."""
    user = User(email=email)
    db.add(user)
    db.commit()
    return user


def delete_task(db, task):
    """db.delete(...) — delete on `task`."""
    db.delete(task)
    db.commit()


def session_alias(session, task_id):
    """`session` (not `db`) is also a recognised receiver."""
    return session.query(Task).get(task_id)
