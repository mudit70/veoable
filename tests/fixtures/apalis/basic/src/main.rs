// Fixture for framework-apalis.

use apalis::prelude::*;
use serde::{Deserialize, Serialize};

// ── Job types — apalis routes by struct type ───────────────────
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct SendEmailJob {
    pub to: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ProcessUploadJob {
    pub upload_id: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct NotifyJob {
    pub user_id: u64,
}

// ── Consumer side: build_fn(<fn>) where fn's first param is the
// job struct ────────────────────────────────────────────────────
async fn send_email(job: SendEmailJob) -> Result<(), apalis::error::Error> {
    let _ = job;
    Ok(())
}

async fn process_upload(job: ProcessUploadJob) -> Result<(), apalis::error::Error> {
    let _ = job;
    Ok(())
}

async fn notify(job: NotifyJob) -> Result<(), apalis::error::Error> {
    let _ = job;
    Ok(())
}

// ── Producer side: storage.push(StructLiteral { ... }) ─────────
async fn enqueue_email(storage: &mut impl Storage<Job = SendEmailJob>) {
    let _ = storage.push(SendEmailJob { to: "user@example.com".into() }).await;
}

async fn enqueue_upload(storage: &mut impl Storage<Job = ProcessUploadJob>) {
    let _ = storage.push(ProcessUploadJob { upload_id: 42 }).await;
}

async fn enqueue_notify(storage: &mut impl Storage<Job = NotifyJob>) {
    let _ = storage.push(NotifyJob { user_id: 7 }).await;
}

// ── Worker registration — connects to build_fn(send_email)
// which the visitor maps back to SendEmailJob via the per-file
// scan of fn signatures.
fn setup_workers() {
    let wb_email = WorkerBuilder::new("send-email")
        .build_fn(send_email);
    let wb_upload = WorkerBuilder::new("process-upload")
        .build_fn(process_upload);
    let wb_notify = WorkerBuilder::new("notify")
        .build_fn(notify);
    let _ = (wb_email, wb_upload, wb_notify);
}

// ── Negative: a .push() on something that isn't an apalis storage
struct PlainQueue;

impl PlainQueue {
    fn push(&mut self, _val: String) {}
}

fn unrelated() {
    let mut q = PlainQueue;
    q.push("not an apalis job".to_string());
}
