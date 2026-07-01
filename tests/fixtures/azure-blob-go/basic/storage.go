package main

import (
	"context"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)

func fetchBlob(ctx context.Context, client *azblob.Client) error {
	// GET → azure://static-assets/logo.png
	_, err := client.DownloadStream(ctx, "static-assets", "logo.png", nil)
	return err
}

func uploadBlob(ctx context.Context, client *azblob.Client, body []byte) error {
	// PUT → azure://user-uploads/inbox/new.txt
	_, err := client.UploadBuffer(ctx, "user-uploads", "inbox/new.txt", body, nil)
	return err
}

func deleteBlob(ctx context.Context, client *azblob.Client) error {
	// DELETE → azure://archive/2026/snapshot.tar
	_, err := client.DeleteBlob(ctx, "archive", "2026/snapshot.tar", nil)
	return err
}

func downloadBuffer(ctx context.Context, client *azblob.Client, buf []byte) error {
	// GET → azure://static-assets/large.bin
	_, err := client.DownloadBuffer(ctx, "static-assets", "large.bin", buf, nil)
	return err
}

func uploadFile(ctx context.Context, client *azblob.Client) error {
	// PUT → azure://user-uploads/movie.mp4
	_, err := client.UploadFile(ctx, "user-uploads", "movie.mp4", nil, nil)
	return err
}

func createContainer(ctx context.Context, client *azblob.Client) error {
	// PUT → azure://new-container/ (container scope)
	_, err := client.CreateContainer(ctx, "new-container", nil)
	return err
}

func deleteContainer(ctx context.Context, client *azblob.Client) error {
	// DELETE → azure://temp-container/ (container scope)
	_, err := client.DeleteContainer(ctx, "temp-container", nil)
	return err
}

func dynamicContainer(ctx context.Context, client *azblob.Client, name string) error {
	// GET (dynamic container) → null URL
	_, err := client.DownloadStream(ctx, name, "logo.png", nil)
	return err
}

func dynamicBlob(ctx context.Context, client *azblob.Client, key string) error {
	// GET (literal container, dynamic blob) → azure://static-assets/ (dynamic)
	_, err := client.DownloadStream(ctx, "static-assets", key, nil)
	return err
}

func rawStringContainer(ctx context.Context, client *azblob.Client) error {
	// GET → azure://raw-bucket/raw-key (raw string literals)
	_, err := client.DownloadStream(ctx, `raw-bucket`, `raw-key`, nil)
	return err
}
