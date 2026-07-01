from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response


class ArticleViewSet(viewsets.ModelViewSet):
    """A standard ModelViewSet — exposes 5 CRUD endpoints under /api/articles/."""
    queryset = []

    def list(self, request):
        return Response([])

    @action(detail=False, methods=['get'])
    def featured(self, request):
        return Response([])

    @action(detail=True, methods=['post'])
    def publish(self, request, pk=None):
        return Response({'ok': True})


class CategoryViewSet(viewsets.ModelViewSet):
    """Pluralization: categor*y* → categor*ies*."""
    queryset = []


class BoxViewSet(viewsets.ModelViewSet):
    """Pluralization: box → box*es*."""
    queryset = []
