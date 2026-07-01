package main

import (
	"context"
	"log"
	"time"

	"github.com/gin-gonic/gin"

	"fleet-monitor/db"
	"fleet-monitor/handlers"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("mongo connect: %v", err)
	}
	defer func() {
		_ = client.Disconnect(context.Background())
	}()

	r := gin.Default()
	r.GET("/api/health", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

	v := handlers.NewVehicleHandler(client)
	r.GET("/api/vehicles", v.List)
	r.GET("/api/vehicles/:id", v.Get)
	r.POST("/api/vehicles", v.Create)

	p := handlers.NewPingHandler(client)
	r.GET("/api/vehicles/:id/pings", p.Recent)
	r.POST("/api/vehicles/:id/pings", p.Insert)

	if err := r.Run(":8080"); err != nil {
		log.Fatal(err)
	}
}
