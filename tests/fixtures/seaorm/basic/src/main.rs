// Fixture for framework-seaorm.
use sea_orm::*;

// ── Entity declarations with explicit table_name ──────────────────
mod user_entity {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
        pub name: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
pub use user_entity::Entity as User;

mod order_entity {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "orders")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub id: i32,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
pub use order_entity::Entity as Order;

// ── Call sites ──────────────────────────────────────────────────
// (Note: v1 only resolves a single per-file `table_name`, so all
//  entity calls in this file map to that one table. Cross-file
//  multi-table is a deliberate v2 follow-up — fully separate
//  entity modules require import-alias resolution.)

async fn read_calls(db: &DatabaseConnection) -> Result<(), DbErr> {
    // Read verbs — emit one DatabaseInteraction each.
    let _ = User::find().all(db).await?;
    let _ = User::find_by_id(1).one(db).await?;
    let _ = User::find_with_related(Order).all(db).await?;
    Ok(())
}

async fn write_calls(db: &DatabaseConnection) -> Result<(), DbErr> {
    // Insert
    let _ = User::insert(user_entity::ActiveModel::default()).exec(db).await?;
    let _ = User::insert_many(vec![]).exec(db).await?;

    // Update
    let _ = User::update_many().exec(db).await?;

    // Delete
    let _ = User::delete_by_id(1).exec(db).await?;
    let _ = User::delete_many().exec(db).await?;
    Ok(())
}

// ── Negatives: not a real entity call ────────────────────────────
async fn negatives() {
    // Lowercase receiver — not an entity (heuristic: must start
    // with uppercase).
    fn find() -> i32 { 1 }
    let _ = find();

    // Self isn't an entity reference.
    // struct S; impl S { fn find() {} } — confirms `Self::find()`
    // would not emit.
}

// ── Reject list: `User::Column::find` / `User::Relation::find` ──
// These are SeaORM internal types, NOT entities. The reject list in
// parseEntityVerbCall drops them so no spurious 'column'/'relation'
// tables get synthesized.
async fn rejected_scoped_paths() {
    use sea_orm::*;
    // Trace: scoped_identifier path = 'User::Column', name = 'find'.
    // lastPathSegment('User::Column') = 'Column' → reject.
    let _ = User::find().filter(user_entity::Column::Name.eq("x")).all;
}

// ── ActiveModel value-form (the dominant SeaORM insert pattern) ──
async fn active_model_value_form(db: &DatabaseConnection) -> Result<(), DbErr> {
    use sea_orm::*;
    // `XxxActiveModel` — receiver text contains 'ActiveModel'.
    // The substring check triggers; entity hint is parsed from the
    // type name (`UserActiveModel` → `User`).
    let am = user_entity::ActiveModel::default();
    let _ = am.insert(db).await?;
    Ok(())
}

// PascalCase receiver with `ActiveModel` suffix.
async fn active_model_pascal(db: &DatabaseConnection) -> Result<(), DbErr> {
    use sea_orm::*;
    let user_am: UserActiveModel = UserActiveModel::default();
    let _ = user_am.update(db).await?;
    let _ = user_am.delete(db).await?;
    Ok(())
}

#[allow(dead_code)]
type UserActiveModel = user_entity::ActiveModel;
