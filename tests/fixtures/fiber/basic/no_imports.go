package main

type fakeApp struct{}

func (a *fakeApp) Get(_ string, _ func()) {}

func local() {
	a := &fakeApp{}
	a.Get("/nope", func() {})
}
