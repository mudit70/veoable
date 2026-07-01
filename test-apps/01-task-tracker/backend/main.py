from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from db import Base, engine
from routers import tasks

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Task Tracker")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tasks.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok"}
