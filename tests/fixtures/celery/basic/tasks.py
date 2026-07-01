"""Fixture for framework-celery."""

from celery import Celery, shared_task

app = Celery('myapp', broker='redis://localhost:6379/0')


# ── @app.task — bare form ──────────────────────────────────────────
@app.task
def process_upload(payload):
    return {'ok': True}


# ── @app.task(name='explicit.name') — explicit task name ──────────
@app.task(name='upload.process')
def explicit_name(payload):
    return None


# ── @shared_task — bare ────────────────────────────────────────────
@shared_task
def maintenance():
    return None


# ── @shared_task(...) — args form ──────────────────────────────────
@shared_task(bind=True, name='cleanup.expired')
def cleanup(self):
    return None


# ── Producer side: <task>.delay() / .apply_async() ─────────────────
def enqueue_upload(payload):
    process_upload.delay(payload)


def enqueue_async():
    explicit_name.apply_async(args=[None])


# ── Producer: app.send_task('explicit.name', ...) ─────────────────
def send_via_name():
    app.send_task('upload.process', args=[None])
    app.send_task('cleanup.expired')


# ── Negative: a non-celery decorator that LOOKS like one ──────────
def custom_decorator(fn):
    return fn


@custom_decorator
def not_a_task():
    return None


# ── Negative: dict.delay() on a dict (not a task object) ──────────
def unrelated_delay():
    data = {'foo': 1}
    return getattr(data, 'delay', lambda: None)()
