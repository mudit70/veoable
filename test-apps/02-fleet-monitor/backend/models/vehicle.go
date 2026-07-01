package models

import "time"

type Vehicle struct {
	ID         string    `bson:"_id" json:"id"`
	FleetID    string    `bson:"fleetId" json:"fleetId"`
	Label      string    `bson:"label" json:"label"`
	Lat        float64   `bson:"lat" json:"lat"`
	Lng        float64   `bson:"lng" json:"lng"`
	SpeedKph   float64   `bson:"speedKph" json:"speedKph"`
	LastSeenAt time.Time `bson:"lastSeenAt" json:"lastSeenAt"`
}

type Ping struct {
	ID        string    `bson:"_id" json:"id"`
	VehicleID string    `bson:"vehicleId" json:"vehicleId"`
	Lat       float64   `bson:"lat" json:"lat"`
	Lng       float64   `bson:"lng" json:"lng"`
	SpeedKph  float64   `bson:"speedKph" json:"speedKph"`
	At        time.Time `bson:"at" json:"at"`
}
