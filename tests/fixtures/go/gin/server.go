package main

import "github.com/gin-gonic/gin"

func listUsers(c *gin.Context)  { c.JSON(200, nil) }
func getUser(c *gin.Context)    { c.JSON(200, nil) }
func createUser(c *gin.Context) { c.JSON(201, nil) }
func deleteUser(c *gin.Context) { c.Status(204) }

func main() {
	router := gin.Default()
	router.GET("/users", listUsers)
	router.GET("/users/:id", getUser)
	router.POST("/users", createUser)
	router.PUT("/users/:id", createUser)
	router.DELETE("/users/:id", deleteUser)
	router.PATCH("/users/:id", createUser)
	router.HEAD("/users", listUsers)
	router.OPTIONS("/users", listUsers)
}
