package main

import "context"

type fakeClient struct{}

func (fakeClient) DownloadStream(_ context.Context, _, _ string, _ any) (any, error) {
	return nil, nil
}
func (fakeClient) DeleteBlob(_ context.Context, _, _ string, _ any) (any, error) {
	return nil, nil
}

func localFetch(ctx context.Context) {
	c := fakeClient{}
	_, _ = c.DownloadStream(ctx, "nope", "nope", nil)
	_, _ = c.DeleteBlob(ctx, "nope", "nope", nil)
}
