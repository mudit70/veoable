package main

import (
	"github.com/gofiber/fiber/v2"
)

func ping(c *fiber.Ctx) error  { return c.SendString("pong") }
func users(c *fiber.Ctx) error { return c.SendStatus(204) }

func main() {
	app := fiber.New()
	app.Get("/ping", ping)
	app.Post("/login", users)
	app.Put("/users/:id", users)
	app.Delete("/users/:id", users)
	app.Patch("/users/:id", users)
	app.Head("/health", users)
	app.Options("/health", users)
	app.All("/echo", ping)
	app.Add("REPORT", "/audit", users)

	api := app.Group("/api")
	v1 := api.Group("/v1")
	v1.Get("/profile", users)

	_ = app.Listen(":8080")
}
