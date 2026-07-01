# FastAPI routes — patterns a framework-fastapi visitor must detect
#
# Detection targets:
#   - @app.get("/path") → APIEndpoint(GET, /api/tasks)
#   - @app.post("/path") → APIEndpoint(POST, /api/tasks)
#   - Depends(get_db) → middleware/dependency injection
#   - Pydantic models → request schema
#   - db.query(Task) → DatabaseInteraction(read, table: tasks)
#   - db.add(task) → DatabaseInteraction(write, table: tasks)

from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from .models import Task, User
from .database import get_db

app = FastAPI()


class TaskCreate(BaseModel):
    title: str


class TaskUpdate(BaseModel):
    status: str


@app.get("/api/tasks")
def list_tasks(db: Session = Depends(get_db)):
    # SQLAlchemy: db.query(Task).all() → DatabaseInteraction(read, tasks)
    return db.query(Task).all()


@app.post("/api/tasks", status_code=201)
def create_task(task: TaskCreate, db: Session = Depends(get_db)):
    # SQLAlchemy: db.add() + db.commit() → DatabaseInteraction(write, tasks)
    db_task = Task(title=task.title, status="todo")
    db.add(db_task)
    db.commit()
    db.refresh(db_task)
    return db_task


@app.get("/api/tasks/{task_id}")
def get_task(task_id: int, db: Session = Depends(get_db)):
    # SQLAlchemy: db.query().filter() → DatabaseInteraction(read, tasks)
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@app.put("/api/tasks/{task_id}")
def update_task(task_id: int, update: TaskUpdate, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    task.status = update.status
    db.commit()
    return task


@app.delete("/api/tasks/{task_id}", status_code=204)
def delete_task(task_id: int, db: Session = Depends(get_db)):
    task = db.query(Task).filter(Task.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    # SQLAlchemy: db.delete() �� DatabaseInteraction(delete, tasks)
    db.delete(task)
    db.commit()
