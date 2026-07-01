package main

import "github.com/gin-gonic/gin"

func listProfile(c *gin.Context)   { c.JSON(200, nil) }
func updateProfile(c *gin.Context) { c.JSON(200, nil) }
func listOrders(c *gin.Context)    { c.JSON(200, nil) }
func health(c *gin.Context)        { c.JSON(200, nil) }

func runWithGroups() {
	router := gin.Default()

	// /api root group.
	api := router.Group("/api")
	api.GET("/health", health) // → /api/health

	// /api/v1 nested group.
	v1 := api.Group("/v1")
	v1.GET("/profile", listProfile)        // → /api/v1/profile
	v1.PUT("/profile/:id", updateProfile)  // → /api/v1/profile/:id

	// /api/v2 sibling group with handler-style route.
	v2 := api.Group("/v2")
	v2.Handle("GET", "/orders", listOrders) // → /api/v2/orders
	v2.Any("/ping", health)                 // → /api/v2/ping (ALL)

	// Plain router routes — no group prefix.
	router.GET("/version", health)
}
