// No poem crate use — zero emits.

pub struct FakeRouter;

impl FakeRouter {
    pub fn at(self, _p: &str, _h: ()) -> Self { self }
}

pub fn local() {
    let _ = FakeRouter.at("/nope", ());
}
