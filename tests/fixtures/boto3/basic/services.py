import boto3

dynamodb = boto3.client("dynamodb")
sqs = boto3.client("sqs")
sns = boto3.client("sns")
lambda_client = boto3.client("lambda")


# ── DynamoDB ──────────────────────────────────────────────────────

def get_user(user_id):
    # GET → dynamodb://users/
    return dynamodb.get_item(
        TableName="users",
        Key={"user_id": {"S": user_id}},
    )


def put_user(item):
    # PUT → dynamodb://users/
    return dynamodb.put_item(TableName="users", Item=item)


def query_orders(user_id):
    # GET → dynamodb://orders/
    return dynamodb.query(TableName="orders", KeyConditionExpression="user_id = :uid")


def scan_audit():
    # GET → dynamodb://audit-log/
    return dynamodb.scan(TableName="audit-log")


def delete_session(session_id):
    # DELETE → dynamodb://sessions/
    return dynamodb.delete_item(TableName="sessions", Key={"session_id": {"S": session_id}})


def update_profile(user_id):
    # PATCH → dynamodb://users/
    return dynamodb.update_item(TableName="users", Key={"user_id": {"S": user_id}})


def create_table():
    # POST → dynamodb://new-table/
    return dynamodb.create_table(TableName="new-table", KeySchema=[])


def dynamic_table(name):
    # GET (dynamic) → null
    return dynamodb.get_item(TableName=name, Key={})


# ── SQS ───────────────────────────────────────────────────────────

def send_order(payload):
    # JOB → sqs:order-events
    return sqs.send_message(
        QueueUrl="https://sqs.us-east-1.amazonaws.com/123456789012/order-events",
        MessageBody=payload,
    )


def receive_order():
    # JOB endpoint
    return sqs.receive_message(
        QueueUrl="https://sqs.us-east-1.amazonaws.com/123456789012/order-events",
    )


def send_dynamic(queue_url, payload):
    # JOB (dynamic queue) → null
    return sqs.send_message(QueueUrl=queue_url, MessageBody=payload)


# ── SNS ───────────────────────────────────────────────────────────

def publish_alert(msg):
    # JOB → sns:critical-alerts
    return sns.publish(
        TopicArn="arn:aws:sns:us-east-1:123456789012:critical-alerts",
        Message=msg,
    )


def publish_to_target(arn, msg):
    # JOB → sns:device-token-x
    return sns.publish(
        TargetArn="arn:aws:sns:us-east-1:123456789012:endpoint/APNS/MyApp/device-token-x",
        Message=msg,
    )


def publish_dynamic(arn, msg):
    # JOB (dynamic ARN) → null
    return sns.publish(TopicArn=arn, Message=msg)


# ── Lambda ────────────────────────────────────────────────────────

def invoke_processor(event):
    # POST → lambda:process-order
    return lambda_client.invoke(
        FunctionName="process-order",
        Payload=event,
    )


def invoke_async_worker(event):
    # JOB → lambda:async-worker
    return lambda_client.invoke_async(FunctionName="async-worker", InvokeArgs=event)


def invoke_dynamic(fn_name, event):
    # POST (dynamic) → null
    return lambda_client.invoke(FunctionName=fn_name, Payload=event)


# ── Collision guards ──────────────────────────────────────────────
# Receivers that LOOK like clients but aren't AWS — these must NOT
# emit. The per-service receiver gate rejects them.

redis_client = None
db_client = None


def redis_publish_not_sns(msg):
    # `publish` is in the verb registry as boto3-sns, but the receiver
    # `redis_client` doesn't match the SNS receiver pattern → no emit.
    return redis_client.publish("channel", msg)


def click_invoke_not_lambda():
    # `invoke` is in the verb registry as boto3-lambda, but the receiver
    # `db_client` doesn't match the Lambda receiver pattern → no emit.
    return db_client.invoke()
