package main

// Fixture for #523-style follow-up: cross-file handler resolution.
//
// Exercises:
//   - bare free-function handler:      `r.GET("/x", handleX)`
//   - method-receiver handler:         `r.GET("/x", v.List)`
//   - ambiguous method-name handler:   `r.GET("/x", v.Same)` where two
//                                       structs both define `Same`
//   - inline anonymous handler:        `r.GET("/x", func(c){...})`
//   - this file's `*Vehicles.List`/`Get`/`Create` line up with how
//     `server.go` uses them via `v := &Vehicles{}; r.GET(..., v.List)`.

import "github.com/gin-gonic/gin"

type Vehicles struct{}

func (v *Vehicles) List(c *gin.Context)   { _ = c }
func (v *Vehicles) Get(c *gin.Context)    { _ = c }
func (v *Vehicles) Create(c *gin.Context) { _ = c }

// Free function — bare-identifier handler case.
func bareHandler(c *gin.Context) { _ = c }

// Two structs with the same method name — ambiguous case, must
// resolve to null rather than picking arbitrarily.
type AmbigA struct{}
type AmbigB struct{}

func (a *AmbigA) Same(c *gin.Context) { _ = c }
func (b *AmbigB) Same(c *gin.Context) { _ = c }
