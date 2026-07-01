// Negative-case fixture for #442 — a file that has NO `use diesel`
// declaration and happens to define a same-named function. The
// bare-form import gate must reject every call here.

fn insert_into(_payload: &str) -> i32 { 0 }
fn update<T>(_table: T) -> i32 { 0 }
fn delete<T>(_table: T) -> i32 { 0 }

pub fn caller() {
    // No diesel in scope — these must NOT register as diesel writes.
    let _ = insert_into("hello");
    let _ = update(42);
    let _ = delete(42);
}
