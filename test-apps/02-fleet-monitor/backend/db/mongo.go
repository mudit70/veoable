package db

import (
	"context"
	"os"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

func Connect(ctx context.Context) (*mongo.Client, error) {
	uri := os.Getenv("MONGO_URI")
	if uri == "" {
		uri = "mongodb://localhost:27017"
	}
	return mongo.Connect(ctx, options.Client().ApplyURI(uri))
}

func Vehicles(client *mongo.Client) *mongo.Collection {
	return client.Database("fleet").Collection("vehicles")
}

func Pings(client *mongo.Client) *mongo.Collection {
	return client.Database("fleet").Collection("pings")
}
