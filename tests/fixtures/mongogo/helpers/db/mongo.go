package db

import "go.mongodb.org/mongo-driver/mongo"

// Helper functions that return collection handles. The mongogo plugin's
// onProjectLoaded scans this file across project boundaries so the
// caller in handlers/vehicles.go can resolve `col := db.Vehicles(c)`
// even though the helper lives in another file.
func Vehicles(client *mongo.Client) *mongo.Collection {
	return client.Database("fleet").Collection("vehicles")
}

func Pings(client *mongo.Client) *mongo.Collection {
	return client.Database("fleet").Collection("pings")
}
