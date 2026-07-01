package main

type fake struct{}

func (f *fake) Publish(_, _ string) {}

func local() {
	f := &fake{}
	f.Publish("nope", "nope")
}
