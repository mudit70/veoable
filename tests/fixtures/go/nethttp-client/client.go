// Fixture for net/http client-side detection (outbound HTTP).
package main

import (
	"net/http"
	"strings"
)

// ── Top-level convenience: http.Get / http.Post / http.Head / http.PostForm ──
func TopLevelGet() (*http.Response, error) {
	return http.Get("https://api.example.com/users")
}

func TopLevelPost() (*http.Response, error) {
	return http.Post(
		"https://api.example.com/users",
		"application/json",
		strings.NewReader("{}"),
	)
}

func TopLevelHead() (*http.Response, error) {
	return http.Head("https://api.example.com/users")
}

func TopLevelPostForm() (*http.Response, error) {
	return http.PostForm("https://api.example.com/login", nil)
}

// ── http.NewRequest for verbs without a top-level shortcut ──────
func PutViaNewRequest() (*http.Request, error) {
	return http.NewRequest("PUT", "https://api.example.com/users/1", nil)
}

func DeleteViaNewRequest() (*http.Request, error) {
	return http.NewRequest("DELETE", "https://api.example.com/users/1", nil)
}

func PatchViaNewRequestWithContext() (*http.Request, error) {
	// NewRequestWithContext has (ctx, method, url, body) — shift index by 1.
	return http.NewRequestWithContext(nil, "PATCH", "https://api.example.com/users/1", nil)
}

// ── Client method chain: <client>.Get / .Post / .Head / .PostForm ──
func ClientMethodChain() {
	client := &http.Client{}
	_, _ = client.Get("https://api.example.com/items")
	_, _ = client.Post("https://api.example.com/items", "application/json", nil)
	_, _ = client.Head("https://api.example.com/items")
	_, _ = client.PostForm("https://api.example.com/form", nil)
}

// ── Receiver heuristic — `httpClient` should match ──────────────
func ApiClientPattern() {
	httpClient := &http.Client{}
	_, _ = httpClient.Get("https://api.example.com/api-client")
}

// ── Dynamic URL — variable instead of literal ───────────────────
func DynamicURL() {
	url := "https://api.example.com/dyn"
	_, _ = http.Get(url)
}

// ── Negative: a method on something that ISN'T a client ─────────
// A user-defined type with a same-named method as net/http.Client.
// The receiver name `bucket` does NOT match the client heuristic
// (`client`/`http`/`api`), so even though we're in a file that
// imports net/http, no ClientSideAPICaller emits for `bucket.Get`.
type bucket struct{}

func (b *bucket) Get(key string) string { return key }

func UnrelatedReceiver() string {
	b := &bucket{}
	return b.Get("https://api.example.com/should-not-emit")
}
