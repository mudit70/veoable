package main

import (
	"context"
	"net/http"

	"nhooyr.io/websocket"
)

func nhooyrHandler(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	_ = c
}

func nhooyrDial(ctx context.Context) error {
	_, _, err := websocket.Dial(ctx, "wss://stream.example.com/v1", nil)
	return err
}
