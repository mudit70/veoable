# Django URL configuration — patterns for route detection
#
# Detection targets:
#   - router.register("articles", ArticleViewSet) → APIEndpoints at /api/articles/
#   - path("api/", include(router.urls)) → route prefix composition

from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import ArticleViewSet, CommentViewSet

router = DefaultRouter()
router.register("articles", ArticleViewSet)
router.register("articles/(?P<article_pk>[^/.]+)/comments", CommentViewSet)

urlpatterns = [
    path("api/", include(router.urls)),
]
