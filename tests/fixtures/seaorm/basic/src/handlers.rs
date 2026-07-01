// Cross-file fixture: handler module that calls into entities
// declared in `entities.rs`. The handler file has NO `#[sea_orm(
// table_name=...)]` attribute itself; the project-wide pre-scan
// must inject the mapping.

use sea_orm::*;
// `pub use ... as Product;` — alias maps to the inner `Entity`
// struct in entities.rs.
pub use crate::entities::Entity as Product;

pub async fn list_products(db: &DatabaseConnection) -> Result<(), DbErr> {
    let _ = Product::find().all(db).await?;
    Ok(())
}

pub async fn create_product(db: &DatabaseConnection) -> Result<(), DbErr> {
    let _ = Product::insert(crate::entities::ActiveModel::default()).exec(db).await?;
    Ok(())
}
