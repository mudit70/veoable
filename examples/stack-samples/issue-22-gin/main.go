package main

import "github.com/gin-gonic/gin"

func listUsers(c *gin.Context) {
	c.JSON(200, []string{"Alice", "Bob"})
}

func getUser(c *gin.Context) {
	id := c.Param("id")
	c.JSON(200, gin.H{"id": id})
}

func createUser(c *gin.Context) {
	c.JSON(201, gin.H{"created": true})
}

func deleteUser(c *gin.Context) {
	c.Status(204)
}

func main() {
	router := gin.Default()
	router.GET("/users", listUsers)
	router.GET("/users/:id", getUser)
	router.POST("/users", createUser)
	router.DELETE("/users/:id", deleteUser)
	router.PUT("/users/:id", createUser)
	router.PATCH("/users/:id", createUser)

	api := router.Group("/api")
	api.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	router.Run(":8080")
}
