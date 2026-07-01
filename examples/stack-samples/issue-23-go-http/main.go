package main

import (
	"fmt"
	"net/http"
)

func listUsers(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, `[{"name":"Alice"}]`)
}

func getUser(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	fmt.Fprintf(w, `{"id":"%s"}`, id)
}

func createUser(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(201)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /users", listUsers)
	mux.HandleFunc("GET /users/{id}", getUser)
	mux.HandleFunc("POST /users", createUser)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"status":"ok"}`)
	})

	http.HandleFunc("DELETE /users/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(204)
	})

	http.ListenAndServe(":8080", mux)
}
