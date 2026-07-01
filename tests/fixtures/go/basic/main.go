package main

import "fmt"

// ExportedFunc is exported (uppercase)
func ExportedFunc() string {
	return "hello"
}

// unexportedFunc is not exported (lowercase)
func unexportedFunc() int {
	return 42
}

// FuncWithParams takes parameters and returns multiple values
func FuncWithParams(name string, age int) (string, error) {
	result := formatGreeting(name)
	return result, nil
}

func formatGreeting(name string) string {
	return fmt.Sprintf("Hello, %s", name)
}

// CallerFunc calls other functions to test call graph edges
func CallerFunc() {
	ExportedFunc()
	result := unexportedFunc()
	fmt.Println(result)
	name, _ := FuncWithParams("Alice", 30)
	fmt.Println(name)
}

func main() {
	CallerFunc()
}
