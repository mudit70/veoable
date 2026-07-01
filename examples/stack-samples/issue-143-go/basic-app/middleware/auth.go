package middleware

import (
	"net/http"
)

// AuthMiddleware wraps a handler with authentication — exported function
func AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if !validateToken(token) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// LoggingMiddleware wraps a handler with request logging
func LoggingMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// log request
		next(w, r)
	}
}

// validateToken is unexported — internal helper
func validateToken(token string) bool {
	return token != ""
}
