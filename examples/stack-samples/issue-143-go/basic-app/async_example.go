package main

import (
	"fmt"
	"sync"
)

// ProcessBatch demonstrates goroutine patterns
func ProcessBatch(items []string) []string {
	var mu sync.Mutex
	var results []string
	var wg sync.WaitGroup

	for _, item := range items {
		wg.Add(1)
		go func(s string) {
			defer wg.Done()
			result := processItem(s)
			mu.Lock()
			results = append(results, result)
			mu.Unlock()
		}(item)
	}

	wg.Wait()
	return results
}

func processItem(s string) string {
	return fmt.Sprintf("processed_%s", s)
}
