package main

import (
	"fmt"
	"net/http"

	"github.com/example/userapi/basic-app/handlers"
	"github.com/example/userapi/basic-app/service"
)

// Exported function (starts with uppercase)
func SetupRoutes() {
	http.HandleFunc("/users", handlers.ListUsers)
	http.HandleFunc("/health", HealthCheck)
}

// Exported function
func HealthCheck(w http.ResponseWriter, r *http.Request) {
	fmt.Fprintf(w, `{"status": "ok"}`)
}

// unexported function (starts with lowercase)
func startServer(port int) error {
	addr := fmt.Sprintf(":%d", port)
	return http.ListenAndServe(addr, nil)
}

func main() {
	SetupRoutes()
	if err := startServer(8080); err != nil {
		fmt.Printf("Server failed: %v\n", err)
	}
}
