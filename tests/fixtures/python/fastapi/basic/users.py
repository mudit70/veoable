from fastapi import APIRouter

# router_prefix = '/users'
router = APIRouter(prefix="/users")


@router.get("/{id}")
async def get_user(id: int):
    return {"id": id}


@router.put("/{id}")
async def update_user(id: int):
    return {}


@router.delete("/{id}")
async def delete_user(id: int):
    return {}


# Bare list endpoint — composes to '/users'.
@router.get("/")
async def list_users():
    return []
