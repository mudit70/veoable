use memcache::Client;

pub fn get_user(client: &Client) -> anyhow::Result<()> {
    let _: Option<String> = client.get("user:1")?;
    Ok(())
}

pub fn set_user(client: &Client) -> anyhow::Result<()> {
    client.set("user:1", "alice", 60)?;
    Ok(())
}

pub fn add_entry(client: &Client) -> anyhow::Result<()> {
    client.add("entry:new", "data", 60)?;
    Ok(())
}

pub fn replace_entry(client: &Client) -> anyhow::Result<()> {
    client.replace("entry:existing", "new-data", 60)?;
    Ok(())
}

pub fn incr_counter(client: &Client) -> anyhow::Result<()> {
    client.increment("counter:requests", 1)?;
    Ok(())
}

pub fn decr_counter(client: &Client) -> anyhow::Result<()> {
    client.decrement("counter:errors", 1)?;
    Ok(())
}

pub fn touch_key(client: &Client) -> anyhow::Result<()> {
    client.touch("session:keepalive", 60)?;
    Ok(())
}

pub fn delete_session(client: &Client) -> anyhow::Result<()> {
    client.delete("session:abc")?;
    Ok(())
}

pub fn flush_all(client: &Client) -> anyhow::Result<()> {
    client.flush()?;
    Ok(())
}

pub fn dynamic_key(client: &Client, key: &str) -> anyhow::Result<()> {
    // Dynamic key — must NOT emit a literal-key interaction.
    let _: Option<String> = client.get(key)?;
    Ok(())
}

fn main() {}
