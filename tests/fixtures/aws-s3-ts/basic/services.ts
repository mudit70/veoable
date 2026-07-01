import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, UpdateItemCommand, DeleteItemCommand, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { LambdaClient, InvokeCommand, InvokeAsyncCommand } from '@aws-sdk/client-lambda';

const dynamo = new DynamoDBClient({});
const sqs = new SQSClient({});
const sns = new SNSClient({});
const lambda = new LambdaClient({});

// ── DynamoDB ──────────────────────────────────────────────────────

export async function getUser(id: string) {
  // GET → dynamodb://users/
  return dynamo.send(new GetItemCommand({ TableName: 'users', Key: { id: { S: id } } }));
}

export async function putUser() {
  // PUT → dynamodb://users/
  return dynamo.send(new PutItemCommand({ TableName: 'users', Item: {} }));
}

export async function queryOrders() {
  // GET → dynamodb://orders/
  return dynamo.send(new QueryCommand({ TableName: 'orders' }));
}

export async function scanAudit() {
  // GET → dynamodb://audit-log/
  return dynamo.send(new ScanCommand({ TableName: 'audit-log' }));
}

export async function updateProfile() {
  // PATCH → dynamodb://users/
  return dynamo.send(new UpdateItemCommand({ TableName: 'users', Key: {} }));
}

export async function deleteSession(id: string) {
  // DELETE → dynamodb://sessions/
  return dynamo.send(new DeleteItemCommand({ TableName: 'sessions', Key: { id: { S: id } } }));
}

export async function createTable() {
  // POST → dynamodb://new-table/
  return dynamo.send(new CreateTableCommand({
    TableName: 'new-table',
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    BillingMode: 'PAY_PER_REQUEST',
  }));
}

export async function dynamicTable(name: string) {
  // GET (dynamic) → null
  return dynamo.send(new GetItemCommand({ TableName: name, Key: {} }));
}

// ── SQS ───────────────────────────────────────────────────────────

export async function sendOrder(body: string) {
  // JOB → sqs:order-events
  return sqs.send(new SendMessageCommand({
    QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/order-events',
    MessageBody: body,
  }));
}

export async function receiveOrder() {
  // JOB → sqs:order-events
  return sqs.send(new ReceiveMessageCommand({
    QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/order-events',
  }));
}

export async function sendDynamic(queueUrl: string, body: string) {
  // JOB (dynamic) → null
  return sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}

// ── SNS ───────────────────────────────────────────────────────────

export async function publishAlert(msg: string) {
  // JOB → sns:critical-alerts
  return sns.send(new PublishCommand({
    TopicArn: 'arn:aws:sns:us-east-1:123456789012:critical-alerts',
    Message: msg,
  }));
}

export async function publishDynamic(arn: string, msg: string) {
  // JOB (dynamic) → null
  return sns.send(new PublishCommand({ TopicArn: arn, Message: msg }));
}

// ── Lambda ────────────────────────────────────────────────────────

export async function invokeProcessor(payload: Uint8Array) {
  // POST → lambda:process-order
  return lambda.send(new InvokeCommand({ FunctionName: 'process-order', Payload: payload }));
}

export async function invokeAsyncWorker(payload: Uint8Array) {
  // JOB → lambda:async-worker
  return lambda.send(new InvokeAsyncCommand({ FunctionName: 'async-worker', InvokeArgs: payload as any }));
}

export async function invokeDynamic(name: string, payload: Uint8Array) {
  // POST (dynamic) → null
  return lambda.send(new InvokeCommand({ FunctionName: name, Payload: payload }));
}
