from fastapi import APIRouter

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
def list_tasks():
    return []


@router.get("/{task_id}")
def get_task(task_id: str):
    return {"id": task_id}


@router.post("")
def create_task(payload: dict):
    return payload


@router.delete("/{task_id}")
def delete_task(task_id: str):
    return None
