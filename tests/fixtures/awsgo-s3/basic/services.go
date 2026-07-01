package main

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// ── DynamoDB ──────────────────────────────────────────────────────

func getUser(ctx context.Context, dynamoClient *dynamodb.Client, id string) error {
	// GET → dynamodb://users/
	_, err := dynamoClient.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String("users"),
	})
	return err
}

func putUser(ctx context.Context, dynamoClient *dynamodb.Client) error {
	// PUT → dynamodb://users/
	_, err := dynamoClient.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String("users"),
	})
	return err
}

func queryOrders(ctx context.Context, dynamoClient *dynamodb.Client) error {
	// GET → dynamodb://orders/
	_, err := dynamoClient.Query(ctx, &dynamodb.QueryInput{
		TableName: aws.String("orders"),
	})
	return err
}

func deleteSession(ctx context.Context, dynamoClient *dynamodb.Client) error {
	// DELETE → dynamodb://sessions/
	_, err := dynamoClient.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String("sessions"),
	})
	return err
}

func updateProfile(ctx context.Context, dynamoClient *dynamodb.Client) error {
	// PATCH → dynamodb://users/
	_, err := dynamoClient.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String("users"),
	})
	return err
}

func dynamicTable(ctx context.Context, dynamoClient *dynamodb.Client, name string) error {
	// GET (dynamic) → null URL
	_, err := dynamoClient.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(name),
	})
	return err
}

// ── SQS ───────────────────────────────────────────────────────────

func sendOrder(ctx context.Context, sqsClient *sqs.Client, payload string) error {
	// JOB → sqs:order-events
	_, err := sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl:    aws.String("https://sqs.us-east-1.amazonaws.com/123456789012/order-events"),
		MessageBody: aws.String(payload),
	})
	return err
}

func receiveOrder(ctx context.Context, sqsClient *sqs.Client) error {
	// JOB → sqs:order-events
	_, err := sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
		QueueUrl: aws.String("https://sqs.us-east-1.amazonaws.com/123456789012/order-events"),
	})
	return err
}

func sendDynamic(ctx context.Context, sqsClient *sqs.Client, queue string) error {
	// JOB (dynamic) → null
	_, err := sqsClient.SendMessage(ctx, &sqs.SendMessageInput{
		QueueUrl: aws.String(queue),
	})
	return err
}

// ── SNS ───────────────────────────────────────────────────────────

func publishAlert(ctx context.Context, snsClient *sns.Client, msg string) error {
	// JOB → sns:critical-alerts
	_, err := snsClient.Publish(ctx, &sns.PublishInput{
		TopicArn: aws.String("arn:aws:sns:us-east-1:123456789012:critical-alerts"),
		Message:  aws.String(msg),
	})
	return err
}

func publishDynamic(ctx context.Context, snsClient *sns.Client, arn, msg string) error {
	// JOB (dynamic) → null
	_, err := snsClient.Publish(ctx, &sns.PublishInput{
		TopicArn: aws.String(arn),
		Message:  aws.String(msg),
	})
	return err
}

// ── Lambda ────────────────────────────────────────────────────────

func invokeProcessor(ctx context.Context, lambdaClient *lambda.Client, payload []byte) error {
	// POST → lambda:process-order
	_, err := lambdaClient.Invoke(ctx, &lambda.InvokeInput{
		FunctionName: aws.String("process-order"),
		Payload:      payload,
	})
	return err
}

func invokeDynamic(ctx context.Context, lambdaClient *lambda.Client, name string) error {
	// POST (dynamic) → null
	_, err := lambdaClient.Invoke(ctx, &lambda.InvokeInput{
		FunctionName: aws.String(name),
	})
	return err
}

// ── Collision guards ──────────────────────────────────────────────

type fakeRedisClient struct{}

func (fakeRedisClient) Publish(_ context.Context, _ any) error { return nil }

type fakeDBClient struct{}

func (fakeDBClient) Invoke(_ context.Context, _ any) error { return nil }

func redisPublishNotSns(ctx context.Context) {
	// redisClient receiver doesn't match SNS gate → no emit.
	redisClient := fakeRedisClient{}
	_ = redisClient.Publish(ctx, nil)
}

func dbInvokeNotLambda(ctx context.Context) {
	// dbClient receiver doesn't match Lambda gate → no emit.
	dbClient := fakeDBClient{}
	_ = dbClient.Invoke(ctx, nil)
}
