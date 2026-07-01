package main

// Routes that exercise every handler-resolution shape in handlers.go.
// Kept separate from server.go so the existing tests there stay
// undisturbed.

import "github.com/gin-gonic/gin"

func registerHandlerRoutes(r *gin.Engine) {
	v := &Vehicles{}

	// Method-receiver handlers — should resolve to Vehicles.List etc.
	r.GET("/api/vehicles", v.List)
	r.GET("/api/vehicles/:id", v.Get)
	r.POST("/api/vehicles", v.Create)

	// Bare free-function handler — should resolve to bareHandler.
	r.GET("/api/bare", bareHandler)

	// Inline anonymous handler — must NOT resolve (lang-go emits no
	// FunctionDefinition for anonymous functions).
	r.GET("/api/inline", func(c *gin.Context) { _ = c })

	// Ambiguous method name `Same` appears on both AmbigA and AmbigB.
	// Must resolve to null rather than picking arbitrarily.
	a := &AmbigA{}
	r.GET("/api/ambig", a.Same)

	// 3-arg form: r.Handle("METHOD", "/path", handler). The handler
	// arg position is 2 (zero-indexed). Must resolve like the 2-arg
	// shapes above.
	r.Handle("GET", "/api/handle", v.List)
}
