package handlers

import (
	"context"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"

	"helpers-fixture/db"
)

type Handler struct {
	client *mongo.Client
}

func (h *Handler) List(ctx context.Context) (int64, error) {
	// Cross-file helper: db.Vehicles(...) returns *mongo.Collection.
	col := db.Vehicles(h.client)
	return col.CountDocuments(ctx, bson.M{})
}

func (h *Handler) GetOne(ctx context.Context, id string) error {
	col := db.Vehicles(h.client)
	return col.FindOne(ctx, bson.M{"_id": id}).Err()
}

func (h *Handler) InsertPing(ctx context.Context, doc any) (any, error) {
	pingCol := db.Pings(h.client)
	return pingCol.InsertOne(ctx, doc)
}

func (h *Handler) UpdateVehicle(ctx context.Context, id string, patch any) (any, error) {
	vehicles := db.Vehicles(h.client)
	return vehicles.UpdateOne(ctx, bson.M{"_id": id}, patch)
}
