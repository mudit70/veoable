package main

// File without gomemcache import — must produce zero emits.

type fakeStore struct{}

func (f *fakeStore) Get(_ string) (interface{}, error) { return nil, nil }

func local() {
	s := &fakeStore{}
	s.Get("not-memcache")
}
