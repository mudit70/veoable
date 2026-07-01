// Fixture for framework-mongorust.

use mongodb::{Client, Collection, Database};
use mongodb::bson::doc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct User {
    id: String,
    name: String,
}

// ── let-binding pattern: every function creates its collection
//    via `let coll = db.collection::<T>("name")`. The per-file
//    scanner picks up these bindings.
async fn get_user(db: &Database, id: &str) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.find_one(doc! { "_id": id }, None).await?;
    Ok(())
}

async fn list_users(db: &Database) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.find(doc! {}, None).await?;
    Ok(())
}

async fn create_user(db: &Database, user: User) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.insert_one(user, None).await?;
    Ok(())
}

async fn create_many(db: &Database, docs: Vec<User>) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.insert_many(docs, None).await?;
    Ok(())
}

async fn update_user(db: &Database, id: &str) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.update_one(
        doc! { "_id": id },
        doc! { "$set": { "name": "x" } },
        None,
    ).await?;
    Ok(())
}

async fn update_many_users(db: &Database) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.update_many(doc! {}, doc! { "$set": { "active": false } }, None).await?;
    Ok(())
}

async fn replace_user(db: &Database, user: User) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.replace_one(doc! { "_id": &user.id }, user, None).await?;
    Ok(())
}

async fn delete_user(db: &Database, id: &str) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.delete_one(doc! { "_id": id }, None).await?;
    Ok(())
}

async fn delete_all(db: &Database) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.delete_many(doc! {}, None).await?;
    Ok(())
}

async fn aggregate(db: &Database) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.aggregate(vec![doc! { "$group": { "_id": "$status" } }], None).await?;
    Ok(())
}

async fn count_users(db: &Database) -> mongodb::error::Result<()> {
    let users = db.collection::<User>("users");
    let _ = users.count_documents(doc! {}, None).await?;
    Ok(())
}

async fn find_and_update_order(db: &Database, id: &str) -> mongodb::error::Result<()> {
    let orders = db.collection::<User>("orders");
    let _ = orders.find_one_and_update(
        doc! { "_id": id },
        doc! { "$set": { "status": "paid" } },
        None,
    ).await?;
    Ok(())
}

async fn list_orders(db: &Database) -> mongodb::error::Result<()> {
    let orders = db.collection::<User>("orders");
    let _ = orders.find(doc! {}, None).await?;
    Ok(())
}

// ── No-turbofish form: `db.collection("name")` (the API can infer T) ──
async fn no_turbofish(db: &Database) -> mongodb::error::Result<()> {
    let products: Collection<User> = db.collection("products");
    let _ = products.find_one(doc! {}, None).await?;
    Ok(())
}

// ── Inline: `db.collection::<T>("name").find_one(...)` ──
async fn inline_collection(db: &Database) -> mongodb::error::Result<()> {
    let _ = db
        .collection::<User>("inline")
        .find_one(doc! {}, None)
        .await?;
    Ok(())
}

// ── self.<coll> binding inside an impl method ──
struct Repo {
    events: Collection<User>,
}

impl Repo {
    fn new(db: &Database) -> Self {
        let events = db.collection::<User>("events");
        Self { events }
    }

    async fn recent(&self) -> mongodb::error::Result<()> {
        let _ = self.events.find(doc! {}, None).await?;
        Ok(())
    }
}

// ── Negative: a method on something that isn't a mongo collection ──
struct PlainStruct;

impl PlainStruct {
    fn find(&self, _q: &str) -> Option<&str> { None }
}

fn unrelated() -> Option<&'static str> {
    let s = PlainStruct;
    s.find("not a mongo call")
}
