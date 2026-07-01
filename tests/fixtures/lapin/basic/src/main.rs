use lapin::{options::*, types::FieldTable, BasicProperties, Channel};

pub async fn publish_order(channel: &Channel) -> lapin::Result<()> {
    channel
        .basic_publish(
            "orders",
            "order.created",
            BasicPublishOptions::default(),
            b"payload",
            BasicProperties::default(),
        )
        .await?
        .await?;
    Ok(())
}

pub async fn publish_audit(channel: &Channel) -> lapin::Result<()> {
    channel
        .basic_publish(
            "audit",
            "audit.write",
            BasicPublishOptions::default(),
            b"payload",
            BasicProperties::default(),
        )
        .await?
        .await?;
    Ok(())
}

pub async fn publish_raw_string(channel: &Channel) -> lapin::Result<()> {
    channel
        .basic_publish(
            r"raw-exchange",
            r"raw.route",
            BasicPublishOptions::default(),
            b"payload",
            BasicProperties::default(),
        )
        .await?
        .await?;
    Ok(())
}

pub async fn publish_dynamic(channel: &Channel, exchange: &str) -> lapin::Result<()> {
    channel
        .basic_publish(
            exchange,
            "order.dynamic",
            BasicPublishOptions::default(),
            b"payload",
            BasicProperties::default(),
        )
        .await?
        .await?;
    Ok(())
}

pub async fn consume_orders(channel: &Channel) -> lapin::Result<()> {
    let _consumer = channel
        .basic_consume(
            "order.created",
            "consumer-tag-orders",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    Ok(())
}

pub async fn consume_audit(channel: &Channel) -> lapin::Result<()> {
    let _consumer = channel
        .basic_consume(
            "audit.write",
            "consumer-tag-audit",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    Ok(())
}

pub async fn consume_dynamic(channel: &Channel, queue: &str) -> lapin::Result<()> {
    let _consumer = channel
        .basic_consume(
            queue,
            "consumer-tag-dyn",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;
    Ok(())
}
