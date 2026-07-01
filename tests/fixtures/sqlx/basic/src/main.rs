// Fixture for framework-sqlx (#439).
//
// Covers:
//   - Positive: macro query!, query_as!, function call query(), method
//     call .execute() on a pool, schema-qualified table name.
//   - Negative: SQL with no recognized verb (CREATE TABLE), dynamic
//     SQL string built from a variable.

use sqlx::PgPool;

#[derive(sqlx::FromRow)]
struct User { id: i64, email: String }

pub async fn list_users(pool: &PgPool) -> Vec<User> {
    sqlx::query_as!(User, "SELECT id, email FROM users")
        .fetch_all(pool)
        .await
        .unwrap()
}

pub async fn find_order(pool: &PgPool, id: i64) -> Option<(i64,)> {
    sqlx::query!("SELECT id FROM public.orders WHERE id = $1", id)
        .fetch_optional(pool)
        .await
        .unwrap()
        .map(|r| (r.id,))
}

pub async fn insert_session(pool: &PgPool, user_id: i64) {
    sqlx::query("INSERT INTO sessions (user_id) VALUES ($1)")
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
}

pub async fn purge_old_carts(pool: &PgPool) {
    let conn = pool;
    conn.execute("DELETE FROM carts WHERE updated_at < NOW() - INTERVAL '30 days'")
        .await
        .unwrap();
}

pub async fn update_email(pool: &PgPool, id: i64, email: &str) {
    sqlx::query!("UPDATE users SET email = $1 WHERE id = $2", email, id)
        .execute(pool)
        .await
        .unwrap();
}

// Negative cases — these MUST NOT produce any DatabaseInteraction.

pub async fn create_schema(pool: &PgPool) {
    // DDL — no DML verb to extract; the visitor should skip.
    sqlx::query("CREATE TABLE IF NOT EXISTS audit_log (id BIGSERIAL, payload JSONB)")
        .execute(pool)
        .await
        .unwrap();
}

pub async fn dynamic(pool: &PgPool, table: &str) {
    // SQL built from a variable — not a string literal at the call
    // site. Must be skipped because we can't statically know the
    // table.
    let sql = format!("SELECT * FROM {}", table);
    sqlx::query(&sql)
        .execute(pool)
        .await
        .unwrap();
}
