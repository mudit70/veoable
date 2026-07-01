package main

import (
	"fmt"
	"net/http"
)

func listUsers(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "[]")
}

func getUser(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, "{}")
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users", listUsers)
	mux.HandleFunc("GET /users/{id}", getUser)
	mux.HandleFunc("POST /users", listUsers)
	mux.HandleFunc("/health", listUsers)

	http.HandleFunc("DELETE /items/{id}", listUsers)
}
