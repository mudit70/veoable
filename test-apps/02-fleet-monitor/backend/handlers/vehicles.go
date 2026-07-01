package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"

	"fleet-monitor/db"
	"fleet-monitor/models"
)

type VehicleHandler struct {
	client *mongo.Client
}

func NewVehicleHandler(client *mongo.Client) *VehicleHandler {
	return &VehicleHandler{client: client}
}

func (h *VehicleHandler) List(c *gin.Context) {
	col := db.Vehicles(h.client)
	cur, err := col.Find(c.Request.Context(), bson.M{})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer cur.Close(c.Request.Context())

	var vs []models.Vehicle
	if err := cur.All(c.Request.Context(), &vs); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, vs)
}

func (h *VehicleHandler) Get(c *gin.Context) {
	id := c.Param("id")
	col := db.Vehicles(h.client)
	var v models.Vehicle
	if err := col.FindOne(c.Request.Context(), bson.M{"_id": id}).Decode(&v); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, v)
}

func (h *VehicleHandler) Create(c *gin.Context) {
	var v models.Vehicle
	if err := c.ShouldBindJSON(&v); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	v.LastSeenAt = time.Now()
	col := db.Vehicles(h.client)
	if _, err := col.InsertOne(c.Request.Context(), v); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, v)
}
