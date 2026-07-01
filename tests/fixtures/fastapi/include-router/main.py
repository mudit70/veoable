from fastapi import FastAPI

from routers import tasks

app = FastAPI()
app.include_router(tasks.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}
