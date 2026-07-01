package main

type FakeStore struct{}

func (s *FakeStore) Create() {}

type FakeEnt struct {
	User *FakeStore
}

func local() {
	e := &FakeEnt{User: &FakeStore{}}
	e.User.Create()
}
