// Fixture for framework-chi.
package main

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func listUsers(w http.ResponseWriter, r *http.Request)   {}
func createUser(w http.ResponseWriter, r *http.Request)  {}
func updateUser(w http.ResponseWriter, r *http.Request)  {}
func deleteUser(w http.ResponseWriter, r *http.Request)  {}
func patchUser(w http.ResponseWriter, r *http.Request)   {}
func headUsers(w http.ResponseWriter, r *http.Request)   {}
func optionsUsers(w http.ResponseWriter, r *http.Request){}
func customHandler(w http.ResponseWriter, r *http.Request){}
func propfindHandler(w http.ResponseWriter, r *http.Request){}
func legacyHandler(w http.ResponseWriter, r *http.Request){}

// ── Canonical chi router setup ─────────────────────────────────
func newRouter() *chi.Mux {
	r := chi.NewRouter()

	r.Get("/users", listUsers)
	r.Post("/users", createUser)
	r.Put("/users/{id}", updateUser)
	r.Delete("/users/{id}", deleteUser)
	r.Patch("/users/{id}", patchUser)
	r.Head("/users", headUsers)
	r.Options("/users", optionsUsers)

	// Custom verb via Method / MethodFunc.
	r.Method("CUSTOM", "/custom-path", http.HandlerFunc(customHandler))
	r.MethodFunc("PROPFIND", "/webdav", propfindHandler)

	// Fallthrough verb via HandleFunc — emit as 'ALL'.
	r.HandleFunc("/legacy", legacyHandler)

	return r
}

// ── Receiver-name heuristic: `mux` should match ────────────────
func setupAlt() *chi.Mux {
	mux := chi.NewRouter()
	mux.Get("/health", listUsers)
	return mux
}

// ── Receiver-name heuristic: a custom name `apiRouter` matches ──
func setupNamed() *chi.Mux {
	apiRouter := chi.NewRouter()
	apiRouter.Get("/api/things", listUsers)
	return apiRouter
}

// ── Negative: a method on something that ISN'T a chi router ────
// `s.Get(key)` on a non-router named `s` must not match.
type kvStore struct{}

func (k *kvStore) Get(key string) string { return key }

func unrelatedGet() string {
	s := &kvStore{}
	return s.Get("/this/is/not/a/route")
}
