package service

import "fmt"

// User represents a user in the system
type User struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// UserService manages user operations — method receiver pattern
type UserService struct {
	users []User
}

// NewUserService creates a new UserService instance
func NewUserService() *UserService {
	return &UserService{
		users: make([]User, 0),
	}
}

// GetAll returns all users — method on UserService
func (s *UserService) GetAll() []User {
	return s.users
}

// FindByID finds a user by ID — method on UserService
func (s *UserService) FindByID(id string) (*User, error) {
	for _, u := range s.users {
		if u.ID == id {
			return &u, nil
		}
	}
	return nil, fmt.Errorf("user %s not found", id)
}

// Create adds a new user — method on UserService
func (s *UserService) Create(name, email string) User {
	user := User{
		ID:    generateID(),
		Name:  name,
		Email: email,
	}
	s.users = append(s.users, user)
	return user
}

// Delete removes a user — method on UserService
func (s *UserService) Delete(id string) error {
	for i, u := range s.users {
		if u.ID == id {
			s.users = append(s.users[:i], s.users[i+1:]...)
			return nil
		}
	}
	return fmt.Errorf("user %s not found", id)
}

// Package-level convenience functions that delegate to a default service
var defaultService = NewUserService()

// GetAllUsers returns all users from the default service
func GetAllUsers() []User {
	return defaultService.GetAll()
}

// FindUser finds a user by ID from the default service
func FindUser(id string) (*User, error) {
	return defaultService.FindByID(id)
}

// CreateUser creates a user via the default service
func CreateUser(name, email string) User {
	return defaultService.Create(name, email)
}

// DeleteUser deletes a user via the default service
func DeleteUser(id string) error {
	return defaultService.Delete(id)
}

// generateID is unexported — internal helper
func generateID() string {
	return fmt.Sprintf("usr_%d", len(defaultService.users)+1)
}
