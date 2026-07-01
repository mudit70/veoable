// Gin handlers — patterns a framework-gin visitor must detect
//
// Detection targets:
//   r.GET("/api/books", ListBooks) → APIEndpoint(GET, /api/books)
//   r.POST("/api/books", CreateBook) → APIEndpoint(POST, /api/books)
//   r.Group("/api") → route prefix composition
//   r.Use(AuthMiddleware()) → middleware detection
//   db.Find(&books) → DatabaseInteraction(read, books)
//   db.Create(&book) → DatabaseInteraction(write, books)
//   db.Delete(&book) → DatabaseInteraction(delete, books)

package handlers

import (
	"net/http"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type BookHandler struct {
	db *gorm.DB
}

func NewBookHandler(db *gorm.DB) *BookHandler {
	return &BookHandler{db: db}
}

func (h *BookHandler) RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api")
	api.Use(AuthMiddleware())

	api.GET("/books", h.ListBooks)
	api.POST("/books", h.CreateBook)
	api.GET("/books/:id", h.GetBook)
	api.PUT("/books/:id", h.UpdateBook)
	api.DELETE("/books/:id", h.DeleteBook)
}

func (h *BookHandler) ListBooks(c *gin.Context) {
	var books []Book
	// GORM: db.Find() → DatabaseInteraction(read, books)
	if err := h.db.Preload("Category").Find(&books).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, books)
}

func (h *BookHandler) GetBook(c *gin.Context) {
	var book Book
	// GORM: db.First() → DatabaseInteraction(read, books)
	if err := h.db.First(&book, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, book)
}

func (h *BookHandler) CreateBook(c *gin.Context) {
	var book Book
	if err := c.ShouldBindJSON(&book); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// GORM: db.Create() → DatabaseInteraction(write, books)
	if err := h.db.Create(&book).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, book)
}

func (h *BookHandler) UpdateBook(c *gin.Context) {
	var book Book
	if err := h.db.First(&book, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err := c.ShouldBindJSON(&book); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// GORM: db.Save() → DatabaseInteraction(write, books)
	h.db.Save(&book)
	c.JSON(http.StatusOK, book)
}

func (h *BookHandler) DeleteBook(c *gin.Context) {
	// GORM: db.Delete() → DatabaseInteraction(delete, books)
	if err := h.db.Delete(&Book{}, c.Param("id")).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.GetHeader("Authorization")
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
			return
		}
		c.Next()
	}
}
