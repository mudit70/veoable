package main

import "github.com/gin-gonic/gin"

func main() {
	router := gin.Default()
	router.GET("/users", func(c *gin.Context) {})
	router.POST("/users", func(c *gin.Context) {})
	router.PUT("/users/:id", func(c *gin.Context) {})
	router.DELETE("/users/:id", func(c *gin.Context) {})
}
