// Cross-file fixture for framework-seaorm.
//
// In real SeaORM codebases entity declarations live in one module
// (`src/entities/*.rs`) and the call sites live elsewhere. The
// project-wide scan in `SeaormPlugin.onProjectLoaded` must pick up
// the table_name attributes here so that handlers.rs's call sites
// resolve correctly.

use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "products")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
