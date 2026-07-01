from fastapi import FastAPI
from .users import router as users_router

app = FastAPI()


# Direct app-level decorators — no prefix.
@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/login")
async def login():
    return {}


# Mount the users router under /api so its routes get composed with /api.
app.include_router(users_router, prefix="/api")
