// No warp use — zero emits even with a similar macro shape.

macro_rules! path {
    ($($arg:tt)*) => { stringify!($($arg)*) };
}

pub fn local() {
    let _ = path!("not" / "a" / "warp" / "route");
}
