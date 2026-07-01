package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/example/userapi/basic-app/service"
)

// ListUsers handles GET /users — exported handler
func ListUsers(w http.ResponseWriter, r *http.Request) {
	users := service.GetAllUsers()
	json.NewEncoder(w).Encode(users)
}

// GetUserByID handles GET /users/:id — exported handler
func GetUserByID(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	user, err := service.FindUser(id)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	json.NewEncoder(w).Encode(user)
}

// CreateUser handles POST /users — exported handler
func CreateUser(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name  string `json:"name"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	user := service.CreateUser(input.Name, input.Email)
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(user)
}

// DeleteUser handles DELETE /users/:id — exported handler
func DeleteUser(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if err := service.DeleteUser(id); err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// formatError is unexported — only used internally
func formatError(msg string) string {
	return fmt.Sprintf(`{"error": "%s"}`, msg)
}
