# Single-file app with prefix composition: APIRouter inside the same
# file as the include_router call. Verifies that a router declared in
# the same module as `app.include_router(...)` gets composed correctly
# without cross-file resolution.
from fastapi import FastAPI, APIRouter

app = FastAPI()

router = APIRouter(prefix="/items")


@router.get("/{id}")
async def get_item(id: int):
    return {"id": id}


app.include_router(router, prefix="/api/v1")


# Plain app route too — should NOT pick up the /api/v1 prefix.
@app.get("/version")
async def version():
    return {"version": 1}
