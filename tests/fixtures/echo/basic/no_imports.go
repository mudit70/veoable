package main

// File without echo import — must produce zero emits.

type fakeRouter struct{}

func (f *fakeRouter) GET(_, _ string) {}

func local() {
	r := &fakeRouter{}
	r.GET("/nope", "h")
}
