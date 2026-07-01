package main

import (
	"github.com/labstack/echo/v4"
)

func ping(c echo.Context) error  { return c.String(200, "pong") }
func users(c echo.Context) error { return c.JSON(200, nil) }
func login(c echo.Context) error { return c.NoContent(204) }
func health(c echo.Context) error { return c.String(200, "ok") }

func main() {
	e := echo.New()
	e.GET("/ping", ping)
	e.POST("/login", login)
	e.PUT("/users/:id", users)
	e.DELETE("/users/:id", users)
	e.PATCH("/users/:id", users)
	e.HEAD("/health", health)
	e.OPTIONS("/health", health)
	e.Any("/echo", ping)
	e.Match([]string{"GET", "POST"}, "/either", ping)

	api := e.Group("/api")
	v1 := api.Group("/v1")
	v1.GET("/profile", users)
	v1.POST("/profile", users)

	_ = e.Start(":8080")
}
