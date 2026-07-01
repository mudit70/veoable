package main

import "github.com/gofiber/fiber/v2"

func listUsers(c *fiber.Ctx) error { return c.JSON(nil) }
func getUser(c *fiber.Ctx) error   { return c.JSON(nil) }

func main() {
	app := fiber.New()
	app.Get("/users", listUsers)
	app.Get("/users/:id", getUser)
	app.Post("/users", listUsers)
	app.Delete("/users/:id", listUsers)
}
