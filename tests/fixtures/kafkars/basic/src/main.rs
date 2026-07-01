use rdkafka::producer::{FutureProducer, FutureRecord, BaseProducer, BaseRecord};
use rdkafka::consumer::{Consumer, StreamConsumer};
use rdkafka::util::Timeout;

pub async fn send_future(producer: &FutureProducer) -> anyhow::Result<()> {
    producer
        .send(
            FutureRecord::to("user-events")
                .payload("hello")
                .key("k1"),
            Timeout::Never,
        )
        .await
        .map_err(|(e, _)| anyhow::anyhow!(e))?;
    Ok(())
}

pub fn send_base(producer: &BaseProducer) -> anyhow::Result<()> {
    producer
        .send(BaseRecord::to("order-events").payload("p").key("k"))
        .map_err(|(e, _)| anyhow::anyhow!(e))?;
    Ok(())
}

pub async fn send_dynamic(producer: &FutureProducer, topic: &str) -> anyhow::Result<()> {
    // Dynamic topic — must NOT emit (no literal).
    producer
        .send(
            FutureRecord::to(topic).payload("p").key("k"),
            Timeout::Never,
        )
        .await
        .map_err(|(e, _)| anyhow::anyhow!(e))?;
    Ok(())
}

pub fn subscribe_to(consumer: &StreamConsumer) -> anyhow::Result<()> {
    consumer.subscribe(&["user-events", "order-events"])?;
    Ok(())
}

pub fn subscribe_single(consumer: &StreamConsumer) -> anyhow::Result<()> {
    consumer.subscribe(&["audit-log"])?;
    Ok(())
}

pub fn subscribe_dynamic(consumer: &StreamConsumer, topic: &str) -> anyhow::Result<()> {
    // Dynamic — array of identifiers, not literals → skipped.
    consumer.subscribe(&[topic])?;
    Ok(())
}

pub async fn send_raw_string(producer: &FutureProducer) -> anyhow::Result<()> {
    // Raw string topic — must extract the inner value.
    producer
        .send(
            FutureRecord::to(r"raw-events").payload("p").key("k"),
            Timeout::Never,
        )
        .await
        .map_err(|(e, _)| anyhow::anyhow!(e))?;
    Ok(())
}

pub async fn send_fully_qualified(producer: &FutureProducer) -> anyhow::Result<()> {
    // Fully-qualified path — callers that don't `use` FutureRecord.
    producer
        .send(
            rdkafka::producer::FutureRecord::to("fq-events").payload("p").key("k"),
            Timeout::Never,
        )
        .await
        .map_err(|(e, _)| anyhow::anyhow!(e))?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    Ok(())
}
