package main

import (
	"net/http"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
}

func dialServer() error {
	_, _, err := websocket.DefaultDialer.Dial("ws://api.example.com/feed", nil)
	return err
}

func dialDynamic(url string) error {
	// Dynamic URL — must NOT emit a caller.
	_, _, err := websocket.DefaultDialer.Dial(url, nil)
	return err
}
