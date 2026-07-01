// Fixture file exercising the explicit single-name + group-import
// shapes for #442. main.rs covers the prelude-glob path; this file
// covers `use diesel::insert_into;` and `use diesel::{update, delete};`
// to confirm both bare-form gates work.

use diesel::PgConnection;
use diesel::ExpressionMethods;
use diesel::QueryDsl;
use diesel::RunQueryDsl;
use diesel::insert_into;
use diesel::{update, delete};

diesel::table! {
    sessions (id) {
        id      -> BigInt,
        user_id -> BigInt,
        token   -> Text,
    }
}

#[derive(Insertable)]
#[diesel(table_name = sessions)]
struct NewSession<'a> {
    user_id: i64,
    token: &'a str,
}

pub fn create_session(conn: &mut PgConnection, uid: i64, token: &str) {
    insert_into(sessions::table)
        .values(&NewSession { user_id: uid, token })
        .execute(conn)
        .unwrap();
}

pub fn rotate_token(conn: &mut PgConnection, id: i64, token: &str) {
    update(sessions::table.find(id))
        .set(sessions::token.eq(token))
        .execute(conn)
        .unwrap();
}

pub fn drop_session(conn: &mut PgConnection, id: i64) {
    delete(sessions::table.find(id)).execute(conn).unwrap();
}
