package main

import (
	"context"
	"io"

	"cloud.google.com/go/storage"
)

func fetchObject(ctx context.Context, client *storage.Client) (io.ReadCloser, error) {
	// GET → gs://static-assets/logo.png
	return client.Bucket("static-assets").Object("logo.png").NewReader(ctx)
}

func uploadObject(ctx context.Context, client *storage.Client) *storage.Writer {
	// PUT → gs://user-uploads/inbox/new.txt
	return client.Bucket("user-uploads").Object("inbox/new.txt").NewWriter(ctx)
}

func deleteObject(ctx context.Context, client *storage.Client) error {
	// DELETE → gs://archive/2026/snapshot.tar
	return client.Bucket("archive").Object("2026/snapshot.tar").Delete(ctx)
}

func headObject(ctx context.Context, client *storage.Client) (*storage.ObjectAttrs, error) {
	// GET (Attrs) → gs://static-assets/logo.png
	return client.Bucket("static-assets").Object("logo.png").Attrs(ctx)
}

func updateObject(ctx context.Context, client *storage.Client) (*storage.ObjectAttrs, error) {
	// PATCH → gs://configs/app.json
	return client.Bucket("configs").Object("app.json").Update(ctx, storage.ObjectAttrsToUpdate{})
}

func listFilesInBucket(ctx context.Context, client *storage.Client) *storage.ObjectIterator {
	// GET → gs://static-assets/ (bucket scope)
	return client.Bucket("static-assets").Objects(ctx, nil)
}

func deleteBucket(ctx context.Context, client *storage.Client) error {
	// DELETE → gs://temp-bucket/ (bucket scope; no .Object() in chain)
	return client.Bucket("temp-bucket").Delete(ctx)
}

func copierStart(ctx context.Context, client *storage.Client, src *storage.ObjectHandle) {
	// POST → gs://archive/dest.tar (CopierFrom)
	_ = client.Bucket("archive").Object("dest.tar").CopierFrom(src)
}

func dynamicBucket(ctx context.Context, client *storage.Client, name string) (io.ReadCloser, error) {
	// GET (dynamic bucket) → null URL
	return client.Bucket(name).Object("logo.png").NewReader(ctx)
}

func dynamicKey(ctx context.Context, client *storage.Client, key string) (io.ReadCloser, error) {
	// GET (literal bucket, dynamic key) → gs://static-assets/ (dynamic confidence)
	return client.Bucket("static-assets").Object(key).NewReader(ctx)
}

func rawStringBucket(ctx context.Context, client *storage.Client) (io.ReadCloser, error) {
	// GET → gs://raw-bucket/raw-key (raw string literals)
	return client.Bucket(`raw-bucket`).Object(`raw-key`).NewReader(ctx)
}
