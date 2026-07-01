package main

import "fmt"

// init functions — special in Go: auto-called, multiple allowed per file
func init() {
	fmt.Println("init 1")
}

func init() {
	fmt.Println("init 2")
}

// MultiParam tests multiple identifiers sharing a type: `a, b int`
func MultiParam(a, b int, c string) string {
	return fmt.Sprintf("%d %d %s", a, b, c)
}

// UnnamedParams tests params without names
func UnnamedParams(int, string) {}

// BlankIdentifier tests _ in parameter list
func BlankIdentifier(_ int, name string) string {
	return name
}

// VariadicFunc tests variadic parameters
func VariadicFunc(prefix string, items ...string) string {
	return fmt.Sprintf("%s: %v", prefix, items)
}

// MultiReturn tests multiple return values
func MultiReturn(id string) (string, error) {
	if id == "" {
		return "", fmt.Errorf("empty id")
	}
	return id, nil
}

// ClosureExample tests anonymous function / closure usage
func ClosureExample() func() string {
	msg := "hello"
	return func() string {
		return msg
	}
}

// GoroutineExample tests go statement with function call
func GoroutineExample() {
	go helperA()
	go func() {
		fmt.Println("anonymous goroutine")
	}()
}
