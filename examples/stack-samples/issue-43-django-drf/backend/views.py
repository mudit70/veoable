# Django REST Framework views — patterns a framework-django visitor must detect
#
# Detection targets:
#   - class ArticleViewSet(ModelViewSet) → APIEndpoints for CRUD
#   - urlpatterns + router.register → route patterns
#   - queryset = Article.objects.all() → DatabaseInteraction(read)
#   - serializer.save() → DatabaseInteraction(write)
#   - Article.objects.filter() → DatabaseInteraction(read)

from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from .models import Article, Comment
from .serializers import ArticleSerializer, CommentSerializer


class ArticleViewSet(viewsets.ModelViewSet):
    """
    ModelViewSet auto-generates:
      GET    /api/articles/       → list()   → Article.objects.all()
      POST   /api/articles/       → create() → serializer.save()
      GET    /api/articles/{id}/  → retrieve()
      PUT    /api/articles/{id}/  → update()
      DELETE /api/articles/{id}/  → destroy()
    """
    queryset = Article.objects.all()
    serializer_class = ArticleSerializer
    permission_classes = [permissions.IsAuthenticatedOrReadOnly]

    def perform_create(self, serializer):
        # Django ORM: serializer.save(author=...) → DatabaseInteraction(write, articles)
        serializer.save(author=self.request.user)

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None):
        """Custom action: POST /api/articles/{id}/publish/"""
        article = self.get_object()
        # Django ORM: article.save() → DatabaseInteraction(write, articles)
        article.is_draft = False
        article.save()
        return Response(ArticleSerializer(article).data)

    @action(detail=True, methods=["get"])
    def comments(self, request, pk=None):
        """GET /api/articles/{id}/comments/"""
        article = self.get_object()
        # Django ORM: article.comments.all() → DatabaseInteraction(read, comments)
        comments = article.comments.all()
        return Response(CommentSerializer(comments, many=True).data)


class CommentViewSet(viewsets.ModelViewSet):
    queryset = Comment.objects.all()
    serializer_class = CommentSerializer

    def get_queryset(self):
        # Django ORM: Comment.objects.filter() → DatabaseInteraction(read, comments)
        return Comment.objects.filter(article_id=self.kwargs["article_pk"])
