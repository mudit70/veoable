// Second module that also defines `duplicate` — any caller that
// just writes `duplicate()` (without `use orders::duplicate;` or
// `use ambig::duplicate;`) should NOT resolve, because there are
// two candidate FunctionDefinitions and the resolver requires
// uniqueness.

pub fn duplicate() -> i32 {
    2
}
