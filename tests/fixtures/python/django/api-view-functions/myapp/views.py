from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response


@api_view(["GET", "POST"])
def list_create_photos(request):
    """Combined list (GET) + create (POST). Stacked decorators."""
    return Response([])


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def request_upload_url(request):
    """Decorator stack — @api_view must still be found."""
    return Response({})


@api_view(http_method_names=["GET", "DELETE"])
def photo_detail(request, photo_id):
    """Kwarg form of @api_view(http_method_names=[...])."""
    return Response({"id": str(photo_id)})


@api_view(["GET"])
def audit_log(request, pk):
    """<int:pk> route converter — normalises to :pk."""
    return Response({"pk": pk})


@api_view(["GET"])
def tag_lookup(request, tag):
    """<slug:tag> route converter — normalises to :tag."""
    return Response({"tag": tag})


def not_decorated(request):
    """No @api_view → should NOT emit an APIEndpoint."""
    return Response()
