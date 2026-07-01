// Fixture for framework-gosqlx (jmoiron/sqlx).
package main

import (
	"github.com/jmoiron/sqlx"
)

type User struct {
	ID   int
	Name string
}

func GetUserByID(db *sqlx.DB, id int) (User, error) {
	var u User
	err := db.Get(&u, "SELECT * FROM users WHERE id = $1", id)
	return u, err
}

func ListUsers(db *sqlx.DB) ([]User, error) {
	var us []User
	err := db.Select(&us, "SELECT * FROM users")
	return us, err
}

func CreateUser(db *sqlx.DB, name string) error {
	_, err := db.Exec("INSERT INTO users (name) VALUES ($1)", name)
	return err
}

func UpdateUserName(db *sqlx.DB, id int, name string) error {
	_, err := db.Exec("UPDATE users SET name = $1 WHERE id = $2", name, id)
	return err
}

func DeleteUser(db *sqlx.DB, id int) error {
	_, err := db.Exec("DELETE FROM users WHERE id = $1", id)
	return err
}

// NamedQuery / NamedExec — sqlx's named-arg helpers.
func CreateOrderNamed(db *sqlx.DB, orderID int) error {
	_, err := db.NamedExec(
		"INSERT INTO orders (id, status) VALUES (:id, :status)",
		map[string]interface{}{"id": orderID, "status": "pending"},
	)
	return err
}

func SelectOrdersNamed(db *sqlx.DB) ([]int, error) {
	rows, err := db.NamedQuery("SELECT * FROM orders WHERE status = :status",
		map[string]interface{}{"status": "active"})
	_ = rows
	return nil, err
}

// Queryx / QueryRowx
func QueryxUsers(db *sqlx.DB) {
	_, _ = db.Queryx("SELECT * FROM users")
}

func QueryRowxUser(db *sqlx.DB, id int) {
	_ = db.QueryRowx("SELECT * FROM users WHERE id = $1", id)
}

// MustExec
func MustDeleteAll(db *sqlx.DB) {
	db.MustExec("DELETE FROM users")
}

// Tx receiver: the same methods work on *sqlx.Tx.
func TxRoundtrip(tx *sqlx.Tx) error {
	_, err := tx.Exec("INSERT INTO audit (msg) VALUES ($1)", "hello")
	return err
}

// ── Negative: a method on something that ISN'T a sqlx receiver ───
type bucket struct{}

func (b *bucket) Get(key string) string { return key }

func unrelated() string {
	b := &bucket{}
	return b.Get("SELECT * FROM users")
}

// ── Negative: a sqlx-named method but receiver doesn't match ────
func nonReceiverName() {
	type queryer struct {
		Queryx func(string) string
	}
	q := queryer{}
	_ = q.Queryx("SELECT * FROM should_not_emit")
}
