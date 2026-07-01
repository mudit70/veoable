package main

// File without kafka imports — must produce zero emits even if it
// happens to use a struct with a `Topic` field.

type fakeConfig struct {
	Topic string
}

func newFake() fakeConfig {
	return fakeConfig{Topic: "not-a-kafka-topic"}
}
