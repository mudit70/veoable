package main

import (
	"context"

	"github.com/segmentio/kafka-go"
)

func newWriterConfig() *kafka.Writer {
	return kafka.NewWriter(kafka.WriterConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "user-events",
	})
}

func newWriterStruct() *kafka.Writer {
	return &kafka.Writer{
		Addr:  kafka.TCP("localhost:9092"),
		Topic: "order-events",
	}
}

func writePerMessage(ctx context.Context, w *kafka.Writer) error {
	return w.WriteMessages(ctx, kafka.Message{
		Topic: "payments",
		Value: []byte("data"),
	})
}

func newReader() *kafka.Reader {
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "user-events",
	})
}

func newReaderDynamic(topic string) *kafka.Reader {
	// Dynamic topic — must NOT emit (no literal).
	return kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   topic,
	})
}
