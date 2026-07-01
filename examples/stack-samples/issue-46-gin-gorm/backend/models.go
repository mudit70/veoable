// GORM models — patterns a framework-gorm visitor must detect
//
// Detection targets:
//   type Book struct with gorm tags → DatabaseTable("books")
//   gorm:"column:title" → DatabaseColumn
//   gorm:"foreignKey:AuthorID" → FOREIGN_KEY edge

package models

import "gorm.io/gorm"

type Book struct {
	gorm.Model
	Title    string `gorm:"not null" json:"title"`
	Author   string `gorm:"not null" json:"author"`
	ISBN     string `gorm:"uniqueIndex" json:"isbn"`
	AuthorID uint   `json:"author_id"`
	Category Category `gorm:"foreignKey:CategoryID"`
	CategoryID uint `json:"category_id"`
}

type Category struct {
	gorm.Model
	Name  string `gorm:"uniqueIndex;not null" json:"name"`
	Books []Book `json:"books"`
}
