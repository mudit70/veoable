// Fixture for framework-diesel (#439, second slice).
//
// Covers:
//   - Schema declarations via diesel::table! (users + orders)
//   - Inserts via diesel::insert_into(...)
//   - Updates via diesel::update(...) on a filter chain
//   - Deletes via diesel::delete(...)
//   - Reads via terminal verbs on a <table>::table chain (find, first,
//     load, get_results)
//   - Negative cases: a non-diesel macro that happens to match shape;
//     a fully dynamic insert_into where the arg is a local variable.

use diesel::prelude::*;

diesel::table! {
    users (id) {
        id    -> BigInt,
        email -> Text,
        name  -> Nullable<Text>,
    }
}

diesel::table! {
    orders (id) {
        id      -> BigInt,
        user_id -> BigInt,
        total   -> Numeric,
    }
}

#[derive(Insertable)]
#[diesel(table_name = users)]
struct NewUser<'a> {
    email: &'a str,
}

pub fn list_users(conn: &mut PgConnection) -> Vec<(i64, String)> {
    users::table
        .select((users::id, users::email))
        .load(conn)
        .unwrap()
}

pub fn find_user(conn: &mut PgConnection, id: i64) -> Option<(i64, String)> {
    users::table.find(id).first(conn).ok()
}

pub fn list_orders_for(conn: &mut PgConnection, uid: i64) -> Vec<(i64, i64)> {
    orders::table
        .filter(orders::user_id.eq(uid))
        .get_results(conn)
        .unwrap()
}

pub fn count_users(conn: &mut PgConnection) -> i64 {
    users::table.count().get_result(conn).unwrap()
}

pub fn create_user(conn: &mut PgConnection, email: &str) {
    diesel::insert_into(users::table)
        .values(&NewUser { email })
        .execute(conn)
        .unwrap();
}

pub fn touch_user(conn: &mut PgConnection, id: i64, name: &str) {
    diesel::update(users::table.find(id))
        .set(users::name.eq(name))
        .execute(conn)
        .unwrap();
}

pub fn purge_user(conn: &mut PgConnection, id: i64) {
    diesel::delete(users::table.find(id))
        .execute(conn)
        .unwrap();
}

// Bare-form positive (#442): `insert_into` / `delete` come from the
// `use diesel::prelude::*;` glob at the top of the file. The visitor
// must accept the unprefixed call because the import gate succeeds.
pub fn create_user_bare(conn: &mut PgConnection, email: &str) {
    insert_into(users::table)
        .values(&NewUser { email })
        .execute(conn)
        .unwrap();
}

pub fn purge_user_bare(conn: &mut PgConnection, id: i64) {
    delete(users::table.find(id)).execute(conn).unwrap();
}

// ── Negative cases ──────────────────────────────────────────────────

pub fn not_diesel_macro() {
    // A different macro that LOOKS table-shaped but isn't diesel::table.
    // Must not produce a DatabaseTable.
    println!("audit_log (id) { id -> BigInt }");
}

pub fn dynamic_insert(conn: &mut PgConnection) {
    // Table reference comes from a local binding — without const
    // propagation we can't resolve it. Must NOT emit an interaction
    // (no false positives) but should not panic.
    let t = users::table;
    diesel::insert_into(t).values(&NewUser { email: "x" }).execute(conn).unwrap();
}
