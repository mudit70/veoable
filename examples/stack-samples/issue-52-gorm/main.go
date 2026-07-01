package main

import "gorm.io/gorm"

type User struct {
	ID    uint
	Name  string
	Email string
}

func listUsers(db *gorm.DB) []User {
	var users []User
	db.Find(&users)
	return users
}

func getUser(db *gorm.DB, id uint) User {
	var user User
	db.First(&user, id)
	return user
}

func createUser(db *gorm.DB, name, email string) {
	user := User{Name: name, Email: email}
	db.Create(&user)
}

func updateUser(db *gorm.DB, id uint, name string) {
	db.Model(&User{}).Where("id = ?", id).Update("name", name)
}

func deleteUser(db *gorm.DB, id uint) {
	db.Delete(&User{}, id)
}

func queryUsers(db *gorm.DB) []User {
	var users []User
	db.Where("active = ?", true).Find(&users)
	return users
}

func rawQuery(db *gorm.DB) []User {
	var users []User
	db.Raw("SELECT * FROM users WHERE active = true").Scan(&users)
	return users
}

func main() {}
