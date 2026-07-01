package main

import "context"

type fakeReader struct{}
type fakeObject struct{}
type fakeBucket struct{}
type fakeClient struct{}

func (fakeObject) NewReader(_ context.Context) (*fakeReader, error) { return nil, nil }
func (fakeObject) Delete(_ context.Context) error                   { return nil }
func (fakeBucket) Object(_ string) *fakeObject                      { return &fakeObject{} }
func (fakeBucket) Delete(_ context.Context) error                   { return nil }
func (fakeClient) Bucket(_ string) *fakeBucket                      { return &fakeBucket{} }

func localFetch(ctx context.Context) {
	c := fakeClient{}
	_, _ = c.Bucket("nope").Object("nope").NewReader(ctx)
}
