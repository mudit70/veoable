// Fixture for framework-asynq.
package main

import (
	"context"

	"github.com/hibiken/asynq"
)

// ── Consumer side: mux.HandleFunc("type:name", handler) ──
func newServer() *asynq.ServeMux {
	mux := asynq.NewServeMux()
	mux.HandleFunc("user:welcome", handleWelcome)
	mux.HandleFunc("user:onboard", handleOnboard)
	mux.Handle("email:send", asynq.HandlerFunc(handleEmail))
	return mux
}

func handleWelcome(ctx context.Context, t *asynq.Task) error { return nil }
func handleOnboard(ctx context.Context, t *asynq.Task) error { return nil }
func handleEmail(ctx context.Context, t *asynq.Task) error   { return nil }

// ── Producer side: client.Enqueue(asynq.NewTask("type", ...)) ──
// v1's binding scanner is per-file flat — two functions using the
// same variable name would conflate. Real-world code typically uses
// distinct helper-var names; we mirror that here.
func enqueueWelcome(client *asynq.Client) {
	welcomeTask := asynq.NewTask("user:welcome", []byte("{}"))
	client.Enqueue(welcomeTask)
}

func enqueueOnboard(ctx context.Context, client *asynq.Client) {
	onboardTask := asynq.NewTask("user:onboard", []byte("{}"))
	client.EnqueueContext(ctx, onboardTask)
}

// Inline form: enqueue the task constructed inside the call.
func enqueueInline(client *asynq.Client) {
	client.Enqueue(asynq.NewTask("email:send", []byte("{}")))
}

// ── Negative: a non-asynq mux receiver ──
type fakeMux struct{}

func (m *fakeMux) HandleFunc(pattern string, handler func()) {}

func unrelated() {
	m := &fakeMux{}
	m.HandleFunc("not:asynq", func() {})
}
