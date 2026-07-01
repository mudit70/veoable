# Django models — patterns a framework-django-orm visitor must detect
#
# Detection targets:
#   - class Article(models.Model) → DatabaseTable("articles")
#   - CharField, TextField, ForeignKey → DatabaseColumn
#   - ForeignKey(User) → FOREIGN_KEY edge

from django.db import models
from django.contrib.auth.models import User


class Article(models.Model):
    title = models.CharField(max_length=200)
    body = models.TextField()
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name="articles")
    published_at = models.DateTimeField(auto_now_add=True)
    is_draft = models.BooleanField(default=True)

    class Meta:
        ordering = ["-published_at"]


class Comment(models.Model):
    article = models.ForeignKey(Article, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(User, on_delete=models.CASCADE)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
