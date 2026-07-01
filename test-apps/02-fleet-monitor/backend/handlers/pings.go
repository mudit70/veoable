package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"fleet-monitor/db"
	"fleet-monitor/models"
)

type PingHandler struct {
	client *mongo.Client
}

func NewPingHandler(client *mongo.Client) *PingHandler {
	return &PingHandler{client: client}
}

func (h *PingHandler) Recent(c *gin.Context) {
	vehicleID := c.Param("id")
	col := db.Pings(h.client)
	opts := options.Find().SetSort(bson.D{{Key: "at", Value: -1}}).SetLimit(50)
	cur, err := col.Find(c.Request.Context(), bson.M{"vehicleId": vehicleID}, opts)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer cur.Close(c.Request.Context())

	var pings []models.Ping
	if err := cur.All(c.Request.Context(), &pings); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pings)
}

func (h *PingHandler) Insert(c *gin.Context) {
	vehicleID := c.Param("id")
	var ping models.Ping
	if err := c.ShouldBindJSON(&ping); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ping.VehicleID = vehicleID
	ping.At = time.Now()

	pingCol := db.Pings(h.client)
	if _, err := pingCol.InsertOne(c.Request.Context(), ping); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Roll latest position onto the vehicle doc.
	vehCol := db.Vehicles(h.client)
	_, _ = vehCol.UpdateOne(
		c.Request.Context(),
		bson.M{"_id": vehicleID},
		bson.M{"$set": bson.M{
			"lat":        ping.Lat,
			"lng":        ping.Lng,
			"speedKph":   ping.SpeedKph,
			"lastSeenAt": ping.At,
		}},
	)
	c.JSON(http.StatusCreated, ping)
}
