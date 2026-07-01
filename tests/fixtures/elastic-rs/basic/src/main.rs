use elasticsearch::{
    Elasticsearch, IndexParts, SearchParts, GetParts, UpdateParts, DeleteParts,
};
use serde_json::json;

pub async fn index_user(client: &Elasticsearch, doc: serde_json::Value) -> anyhow::Result<()> {
    client.index(IndexParts::Index("users"))
        .body(doc)
        .send()
        .await?;
    Ok(())
}

pub async fn search_orders(client: &Elasticsearch, body: serde_json::Value) -> anyhow::Result<()> {
    client.search(SearchParts::Index(&["orders"]))
        .body(body)
        .send()
        .await?;
    Ok(())
}

pub async fn get_user(client: &Elasticsearch, id: &str) -> anyhow::Result<()> {
    client.get(GetParts::IndexId("users", id))
        .send()
        .await?;
    Ok(())
}

pub async fn update_user(client: &Elasticsearch, id: &str) -> anyhow::Result<()> {
    client.update(UpdateParts::IndexId("users", id))
        .body(json!({"doc": {"x": 1}}))
        .send()
        .await?;
    Ok(())
}

pub async fn delete_user(client: &Elasticsearch, id: &str) -> anyhow::Result<()> {
    client.delete(DeleteParts::IndexId("users", id))
        .send()
        .await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Ok(())
}
