package main

import "github.com/labstack/echo/v4"

func listUsers(c echo.Context) error { return c.JSON(200, nil) }
func getUser(c echo.Context) error   { return c.JSON(200, nil) }

func main() {
	e := echo.New()
	e.GET("/users", listUsers)
	e.GET("/users/:id", getUser)
	e.POST("/users", listUsers)
	e.DELETE("/users/:id", listUsers)
}
