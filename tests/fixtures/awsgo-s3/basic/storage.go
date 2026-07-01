// Fixture for framework-awsgo-s3.
package main

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var s3Client *s3.Client

func GetUserAvatar(ctx context.Context, key string) {
	s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String("avatars"),
		Key:    aws.String("users/static.png"),
	})
}

func HeadCheck(ctx context.Context) {
	s3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String("avatars"),
		Key:    aws.String("ready.png"),
	})
}

func ListRecent(ctx context.Context) {
	s3Client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String("audit-logs"),
	})
}

func UploadAvatar(ctx context.Context, data []byte) {
	s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String("avatars"),
		Key:    aws.String("users/1.png"),
	})
}

func CopyToArchive(ctx context.Context) {
	s3Client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String("avatars-archive"),
		Key:        aws.String("backup.png"),
		CopySource: aws.String("avatars/original.png"),
	})
}

func DeleteAvatar(ctx context.Context) {
	s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String("avatars"),
		Key:    aws.String("old.png"),
	})
}

func DeleteAuditLogs(ctx context.Context) {
	s3Client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String("audit-logs"),
	})
}

func CreateUpload(ctx context.Context) {
	s3Client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: aws.String("uploads"),
		Key:    aws.String("big.bin"),
	})
}

// ── Dynamic bucket — non-literal value ───────────────────────────
func DynamicBucket(ctx context.Context, bucket string) {
	s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String("dynamic.txt"),
	})
}

// ── Selector receiver: `service.s3Client.GetObject(...)` ──
type StorageService struct {
	s3Client *s3.Client
}

func (s *StorageService) Fetch(ctx context.Context) {
	s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String("service-bucket"),
		Key:    aws.String("data.json"),
	})
}

// ── Negative: a method on something that isn't an S3 client ──
type kvStore struct{}

func (k *kvStore) GetObject(ctx context.Context, _ any) any { return nil }

func unrelated(ctx context.Context) {
	k := &kvStore{}
	k.GetObject(ctx, nil)
}
