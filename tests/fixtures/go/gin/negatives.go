package main

// Non-Gin receiver — should NOT match
type myRouter struct{}
func (r *myRouter) GET(path string, handler interface{}) {}

func main() {
	r := &myRouter{}
	r.GET("/wont-match", nil)
}
