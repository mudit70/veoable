package main

import (
	"github.com/IBM/sarama"
)

func sendProducerMessage(producer sarama.SyncProducer) error {
	msg := &sarama.ProducerMessage{
		Topic: "notifications",
		Value: sarama.ByteEncoder([]byte("data")),
	}
	_, _, err := producer.SendMessage(msg)
	return err
}

func consumePartition(consumer sarama.Consumer) error {
	_, err := consumer.ConsumePartition("audit-log", 0, sarama.OffsetNewest)
	return err
}

func consumePartitionDynamic(consumer sarama.Consumer, topic string) error {
	// Dynamic topic — must NOT emit.
	_, err := consumer.ConsumePartition(topic, 0, sarama.OffsetNewest)
	return err
}
