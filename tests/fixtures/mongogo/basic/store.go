// Fixture for framework-mongogo.
package main

import (
	"context"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
)

var (
	client *mongo.Client
	db     = client.Database("mydb")
	users  = db.Collection("users")
	orders = db.Collection("orders")
)

func GetUser(ctx context.Context, id string) {
	users.FindOne(ctx, bson.M{"_id": id})
}

func ListUsers(ctx context.Context) {
	users.Find(ctx, bson.M{})
}

func CreateUser(ctx context.Context, doc any) {
	users.InsertOne(ctx, doc)
}

func CreateMany(ctx context.Context, docs []any) {
	users.InsertMany(ctx, docs)
}

func UpdateUser(ctx context.Context, id string, update any) {
	users.UpdateOne(ctx, bson.M{"_id": id}, update)
}

func UpdateManyUsers(ctx context.Context, filter, update any) {
	users.UpdateMany(ctx, filter, update)
}

func ReplaceUser(ctx context.Context, id string, doc any) {
	users.ReplaceOne(ctx, bson.M{"_id": id}, doc)
}

func DeleteUser(ctx context.Context, id string) {
	users.DeleteOne(ctx, bson.M{"_id": id})
}

func DeleteAll(ctx context.Context, filter any) {
	users.DeleteMany(ctx, filter)
}

func AggregateUsers(ctx context.Context, pipeline any) {
	users.Aggregate(ctx, pipeline)
}

func CountUsers(ctx context.Context, filter any) {
	users.CountDocuments(ctx, filter)
}

func FindAndUpdate(ctx context.Context, id string, update any) {
	orders.FindOneAndUpdate(ctx, bson.M{"_id": id}, update)
}

func ListOrders(ctx context.Context) {
	orders.Find(ctx, bson.M{})
}

// ── short var declaration: `:=` form ──
func ShortVarDecl(ctx context.Context) {
	products := db.Collection("products")
	products.Find(ctx, bson.M{})
}

// ── selector receiver: `s.coll.FindOne(...)` ──
type Repo struct {
	events *mongo.Collection
}

func (r *Repo) Recent(ctx context.Context) {
	r.events.Find(ctx, bson.M{})
}

// Init the receiver field — exercised by the visitor's selector
// resolution. The receiver-binding scan walks ALL assignments.
func NewRepo() *Repo {
	r := &Repo{}
	r.events = db.Collection("events")
	return r
}

// ── Negative: method on something that isn't a mongo collection ──
type kv struct{}

func (k *kv) FindOne(ctx context.Context, q any) any { return nil }

func unrelated(ctx context.Context) {
	k := &kv{}
	k.FindOne(ctx, nil)
}
