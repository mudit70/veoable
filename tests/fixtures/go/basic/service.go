package main

import "fmt"

// UserService has methods with receivers
type UserService struct {
	name string
}

// NewUserService is a constructor function
func NewUserService(name string) *UserService {
	return &UserService{name: name}
}

// GetAll is a method on UserService (pointer receiver)
func (s *UserService) GetAll() []string {
	return []string{"Alice", "Bob"}
}

// Create is a method on UserService (pointer receiver)
func (s *UserService) Create(name string) string {
	return fmt.Sprintf("created %s", name)
}

// String is a method on UserService (value receiver)
func (s UserService) String() string {
	return s.name
}

// Helper interface for testing
type Repository interface {
	FindAll() []string
	FindByID(id string) (string, error)
}
