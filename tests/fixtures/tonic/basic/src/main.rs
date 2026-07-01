// Fixture for framework-tonic (#439 third slice).
//
// Covers:
//   - A canonical gRPC service impl with three RPC methods
//     (say_hello, say_goodbye, list_users)
//   - One scoped-path trait impl (`greeter_server::Greeter`) to
//     pin lastPathSegment behavior
//   - One generic impl (`impl Echo for EchoServer<T>`) to confirm
//     extractImplType strips the generic
//   - Negative: a regular non-tonic impl block (no #[tonic::async_trait])
//   - Negative: a tonic impl whose method is synchronous (no async)
//   - Negative: a "lookalike" impl with a #[derive(...)] attribute but
//     no tonic::async_trait

#[derive(Default)]
pub struct MyGreeter {}

#[derive(Default)]
pub struct EchoServer<T> {
    _phantom: std::marker::PhantomData<T>,
}

#[tonic::async_trait]
impl Greeter for MyGreeter {
    async fn say_hello(
        &self,
        _request: tonic::Request<HelloRequest>,
    ) -> Result<tonic::Response<HelloReply>, tonic::Status> {
        Ok(tonic::Response::new(HelloReply { message: "hi".into() }))
    }

    async fn say_goodbye(
        &self,
        _request: tonic::Request<GoodbyeRequest>,
    ) -> Result<tonic::Response<GoodbyeReply>, tonic::Status> {
        Ok(tonic::Response::new(GoodbyeReply { message: "bye".into() }))
    }

    async fn list_users(
        &self,
        _request: tonic::Request<ListUsersRequest>,
    ) -> Result<tonic::Response<ListUsersReply>, tonic::Status> {
        Ok(tonic::Response::new(ListUsersReply { users: vec![] }))
    }
}

#[tonic::async_trait]
impl greeter_server::Greeter for AnotherGreeter {
    async fn say_hello(
        &self,
        _request: tonic::Request<HelloRequest>,
    ) -> Result<tonic::Response<HelloReply>, tonic::Status> {
        Ok(tonic::Response::new(HelloReply { message: "alt".into() }))
    }
}

// Bare `#[async_trait]` after `use tonic::async_trait;` (the more
// common form in real OSS code).
use tonic::async_trait;

pub struct BareGreeter {}

#[async_trait]
impl BareTrait for BareGreeter {
    async fn bare_method(
        &self,
        _request: tonic::Request<HelloRequest>,
    ) -> Result<tonic::Response<HelloReply>, tonic::Status> {
        Ok(tonic::Response::new(HelloReply { message: "bare".into() }))
    }
}

pub trait BareTrait {}

// `#[async_trait(?Send)]` — the documented arg-form, used in no_std
// or non-Send-future codebases. Must still register.
pub struct NonSendGreeter {}
pub trait NonSendTrait {}

#[async_trait(?Send)]
impl NonSendTrait for NonSendGreeter {
    async fn non_send_method(
        &self,
        _request: tonic::Request<HelloRequest>,
    ) -> Result<tonic::Response<HelloReply>, tonic::Status> {
        Ok(tonic::Response::new(HelloReply { message: "ns".into() }))
    }
}

// Negative: bare-form-looking-but-not — `#[async_trait_helper]`
// shares a prefix with `async_trait` but is a DIFFERENT attribute.
// The `\b` anchor in the bare-form regex must reject it.
pub struct LookalikeGreeter {}
pub trait LookalikeTrait {}

#[async_trait_helper]
impl LookalikeTrait for LookalikeGreeter {
    async fn lookalike_method(&self) -> i32 { 1 }
}

// Scoped IMPL TYPE — `impl Trait for path::ScopedStruct`. lang-rust
// registers the FunctionDefinition under `path::ScopedStruct.<method>`
// (the full path is preserved); the visitor's handler-id computation
// must mirror that or the endpoint and function never join.
#[tonic::async_trait]
impl Whisper for inner_mod::ScopedGreeter {
    async fn whisper(
        &self,
        _request: tonic::Request<HelloRequest>,
    ) -> Result<tonic::Response<HelloReply>, tonic::Status> {
        Ok(tonic::Response::new(HelloReply { message: "shh".into() }))
    }
}

#[tonic::async_trait]
impl<T> Echo for EchoServer<T> {
    async fn echo(
        &self,
        _request: tonic::Request<EchoRequest>,
    ) -> Result<tonic::Response<EchoReply>, tonic::Status> {
        Ok(tonic::Response::new(EchoReply { message: "echo".into() }))
    }
}

// Negative: a regular impl block with NO #[tonic::async_trait].
impl MyGreeter {
    pub fn helper(&self) -> i32 { 42 }

    pub async fn definitely_not_a_grpc_method(&self) -> Result<(), ()> {
        Ok(())
    }
}

// Negative: a #[tonic::async_trait] impl whose method is sync.
// Tonic spec REQUIRES async fns; a sync one isn't a real RPC.
#[tonic::async_trait]
impl SyncTrait for MyGreeter {
    fn never_emitted(&self) -> i32 { 1 }
}

// Negative: only a #[derive(...)] attribute on the struct above it.
// No tonic attribute on the impl below — must not register.
#[derive(Default)]
pub struct UnrelatedStruct {}

impl UnrelatedStruct {
    pub async fn unrelated_method(&self) {}
}

pub struct AnotherGreeter {}

pub struct HelloRequest { pub name: String }
pub struct HelloReply { pub message: String }
pub struct GoodbyeRequest { pub name: String }
pub struct GoodbyeReply { pub message: String }
pub struct ListUsersRequest {}
pub struct ListUsersReply { pub users: Vec<String> }
pub struct EchoRequest { pub message: String }
pub struct EchoReply { pub message: String }

pub trait Greeter {}
pub trait Echo {}
pub trait Whisper {}
pub trait SyncTrait {}

pub mod greeter_server {
    pub trait Greeter {}
}

pub mod inner_mod {
    pub struct ScopedGreeter {}
}
