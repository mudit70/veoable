"""Negative: no celery import. Visitor must not fire."""


def task(fn):
    return fn


@task
def looks_like_task():
    return None
