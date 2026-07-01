package main

import "fmt"

func helperA() string {
	return "a"
}

func helperB() string {
	return "b"
}

// ConditionalCalls tests conditional call detection.
// Calls helperA unconditionally and helperB inside an if.
// Both targets are defined above (same file, before caller) so they
// resolve in the single-pass walk.
func ConditionalCalls(flag bool) {
	// Unconditional call
	result := helperA()

	// Conditional call inside if
	if flag {
		helperB()
	}

	fmt.Println(result)
}
