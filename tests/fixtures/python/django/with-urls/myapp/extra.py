from rest_framework import viewsets


class TagViewSet(viewsets.ModelViewSet):
    """Not registered with any router — should fall back to /api/tags/."""
    queryset = []
