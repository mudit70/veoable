// Negative: file with NO chi import — method-call shape gated off.
package main

func notARealRouter() {
	type fakeRouter struct{}
	r := &fakeRouter{}
	_ = r
}
