package main

import (
	"fmt"
	"net/http"
	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:   "app",
	Short: "User management CLI",
}

var listCmd = &cobra.Command{
	Use:   "list",
	Short: "List all users",
	Run: func(cmd *cobra.Command, args []string) {
		resp, _ := http.Get("http://localhost:8000/api/users")
		fmt.Println(resp.Status)
	},
}

var getCmd = &cobra.Command{
	Use:   "get [id]",
	Short: "Get a user by ID",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		resp, _ := http.Get(fmt.Sprintf("http://localhost:8000/api/users/%s", args[0]))
		fmt.Println(resp.Status)
	},
}

var createCmd = &cobra.Command{
	Use:   "create",
	Short: "Create a user",
	Run: func(cmd *cobra.Command, args []string) {
		resp, _ := http.Post("http://localhost:8000/api/users", "application/json", nil)
		fmt.Println(resp.Status)
	},
}

func main() {
	rootCmd.AddCommand(listCmd)
	rootCmd.AddCommand(getCmd)
	rootCmd.AddCommand(createCmd)
	rootCmd.Execute()
}
