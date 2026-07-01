package main

import (
	"context"

	"ent-fixture/ent"
)

func createUser(ctx context.Context, client *ent.Client) error {
	_, err := client.User.Create().SetName("alice").SetAge(30).Save(ctx)
	return err
}

func listUsers(ctx context.Context, client *ent.Client) error {
	_, err := client.User.Query().All(ctx)
	return err
}

func getUser(ctx context.Context, client *ent.Client) error {
	_, err := client.User.Get(ctx, 1)
	return err
}

func updateUser(ctx context.Context, client *ent.Client) error {
	_, err := client.User.Update().SetAge(31).Save(ctx)
	return err
}

func deleteUser(ctx context.Context, client *ent.Client) error {
	_, err := client.User.Delete().Exec(ctx)
	return err
}

func createOrder(ctx context.Context, client *ent.Client) error {
	_, err := client.Order.Create().SetTotal(100).Save(ctx)
	return err
}

func queryOrders(ctx context.Context, client *ent.Client) error {
	_, err := client.Order.Query().All(ctx)
	return err
}
