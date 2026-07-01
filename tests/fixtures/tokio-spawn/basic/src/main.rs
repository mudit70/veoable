// Fixture for #538 — framework-tokio-spawn.
//
// Exercises:
//   - tokio::spawn(async move { ... }) — inline future
//   - tokio::spawn(named_handler()) — named call
//   - tokio::task::spawn(...) — `task` submodule alias
//   - Multiple spawns in the same function (distinct nodes per site)
//
// Negative cases that must NOT emit:
//   - tokio::spawn_blocking(...) — blocking pool, different category
//   - other.spawn(...) — receiver isn't tokio
//   - tokio::other_call(...) — name isn't `spawn`

use tokio;

async fn named_handler() {
    println!("background work");
}

pub async fn one_spawn() {
    tokio::spawn(async move {
        println!("a");
    });
}

pub async fn two_spawns() {
    // Two sites in the same function — each should emit a distinct
    // ClientSideProcess (id is (sourceFileId, sourceLine, name)).
    tokio::spawn(async move { println!("first"); });
    tokio::spawn(named_handler());
}

pub async fn task_module_spawn() {
    // tokio::task::spawn is accepted.
    tokio::task::spawn(async move { println!("task module"); });
}

pub async fn negative_spawn_blocking() {
    // spawn_blocking is for sync work; we deliberately don't emit.
    tokio::task::spawn_blocking(|| println!("blocking"));
}

pub async fn negative_other_receiver() {
    let other = Other {};
    other.spawn(); // receiver isn't tokio
}

pub async fn negative_other_method() {
    tokio::spawn_local(async move { println!("local"); });
}

struct Other;
impl Other {
    fn spawn(&self) {}
}
