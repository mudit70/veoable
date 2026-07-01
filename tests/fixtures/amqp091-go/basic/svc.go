package main

import (
	"context"

	amqp "github.com/rabbitmq/amqp091-go"
)

func publishOrder(ch *amqp.Channel) error {
	return ch.PublishWithContext(context.Background(),
		"orders", "order.created", false, false,
		amqp.Publishing{Body: []byte("data")},
	)
}

func publishAudit(ch *amqp.Channel) error {
	return ch.Publish("audit", "audit.write", false, false,
		amqp.Publishing{Body: []byte("data")},
	)
}

func consumeOrders(ch *amqp.Channel) error {
	_, err := ch.Consume("order.created", "tag", false, false, false, false, nil)
	return err
}

func consumeAudit(ch *amqp.Channel) error {
	_, err := ch.ConsumeWithContext(context.Background(),
		"audit.write", "tag", false, false, false, false, nil)
	return err
}

func dynamicTopic(ch *amqp.Channel, rk string) error {
	return ch.Publish("orders", rk, false, false, amqp.Publishing{})
}
