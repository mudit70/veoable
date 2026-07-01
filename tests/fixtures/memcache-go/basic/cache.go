package main

import (
	"github.com/bradfitz/gomemcache/memcache"
)

var mc = memcache.New("localhost:11211")

func getUser() error {
	_, err := mc.Get("user:1")
	return err
}

func setUser() error {
	return mc.Set(&memcache.Item{Key: "user:1", Value: []byte("alice")})
}

func addEntry() error {
	return mc.Add(&memcache.Item{Key: "entry:new", Value: []byte("data")})
}

func replaceEntry() error {
	return mc.Replace(&memcache.Item{Key: "entry:existing", Value: []byte("new")})
}

func incrCounter() error {
	_, err := mc.Increment("counter:requests", 1)
	return err
}

func decrCounter() error {
	_, err := mc.Decrement("counter:errors", 1)
	return err
}

func touchKey() error {
	return mc.Touch("session:keepalive", 60)
}

func deleteSession() error {
	return mc.Delete("session:abc")
}

func flushAll() error {
	return mc.FlushAll()
}

func dynamicKey(k string) error {
	// Dynamic — must NOT emit a literal-key interaction.
	_, err := mc.Get(k)
	return err
}
