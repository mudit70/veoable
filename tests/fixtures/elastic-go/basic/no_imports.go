package main

// File without go-elasticsearch import — must produce zero emits.

type fakeStore struct{}

func (f *fakeStore) Get(_, _ string) error { return nil }

func local() {
	s := &fakeStore{}
	s.Get("not-elastic", "1")
}
