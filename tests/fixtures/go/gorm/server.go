package main

import "gorm.io/gorm"

type Item struct {
	ID   uint
	Name string
}

func findAll(db *gorm.DB) []Item {
	var items []Item
	db.Find(&items)
	return items
}

func findOne(db *gorm.DB, id uint) Item {
	var item Item
	db.First(&item, id)
	return item
}

func create(db *gorm.DB) {
	db.Create(&Item{Name: "test"})
}

func update(db *gorm.DB, id uint) {
	db.Model(&Item{}).Where("id = ?", id).Update("name", "updated")
}

func remove(db *gorm.DB, id uint) {
	db.Delete(&Item{}, id)
}

func filtered(db *gorm.DB) []Item {
	var items []Item
	db.Where("name = ?", "test").Find(&items)
	return items
}

func rawSQL(db *gorm.DB) []Item {
	var items []Item
	db.Raw("SELECT * FROM items").Scan(&items)
	return items
}

func execSQL(db *gorm.DB) {
	db.Exec("DELETE FROM items WHERE id = 0")
}
