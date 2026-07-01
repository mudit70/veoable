from datetime import datetime
from pydantic import BaseModel


class TaskCreate(BaseModel):
    title: str
    description: str = ""


class TaskOut(BaseModel):
    id: str
    title: str
    description: str
    completed: bool
    createdAt: datetime

    model_config = {"from_attributes": True}
