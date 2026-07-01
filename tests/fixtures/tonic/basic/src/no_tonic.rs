// Negative-case fixture: this file uses bare `#[async_trait]` but
// imports it from the standalone `async-trait` crate, NOT from
// tonic. The visitor must skip it because the per-file `use tonic::*`
// scanner finds no tonic imports.

use async_trait::async_trait;

pub struct PlainStruct {}
pub trait PlainTrait {
    async fn boring(&self) -> i32;
}

#[async_trait]
impl PlainTrait for PlainStruct {
    async fn boring(&self) -> i32 { 42 }
}
