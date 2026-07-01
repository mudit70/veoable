package main

import (
	segkafka "github.com/segmentio/kafka-go"
	sar "github.com/IBM/sarama"
)

func newAliasedWriter() *segkafka.Writer {
	return segkafka.NewWriter(segkafka.WriterConfig{
		Brokers: []string{"localhost:9092"},
		Topic:   "aliased-events",
	})
}

func sendAliasedSaramaMessage(p sar.SyncProducer) error {
	msg := &sar.ProducerMessage{
		Topic: "aliased-sarama-events",
		Value: sar.ByteEncoder([]byte("data")),
	}
	_, _, err := p.SendMessage(msg)
	return err
}
