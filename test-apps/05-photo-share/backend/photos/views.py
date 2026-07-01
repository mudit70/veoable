from rest_framework import status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import Photo
from .serializers import PhotoSerializer
from .services import (
    cached_feed,
    delete_object,
    invalidate_feed,
    presign_upload,
    store_feed_cache,
)


@api_view(["GET", "POST"])
def list_create_photos(request):
    if request.method == "POST":
        photo = Photo.objects.create(
            uploader_id=request.data.get("uploaderId", "anonymous"),
            s3_key=request.data["s3Key"],
            caption=request.data.get("caption", ""),
        )
        invalidate_feed()
        return Response(PhotoSerializer(photo).data, status=status.HTTP_201_CREATED)

    cached = cached_feed()
    if cached is not None:
        return Response(cached)
    rows = Photo.objects.all()[:50]
    payload = PhotoSerializer(rows, many=True).data
    store_feed_cache(payload)
    return Response(payload)


@api_view(["POST"])
def request_upload_url(request):
    content_type = request.data.get("contentType", "image/jpeg")
    return Response(presign_upload(content_type))


@api_view(["GET", "DELETE"])
def photo_detail(request, photo_id):
    try:
        photo = Photo.objects.get(id=photo_id)
    except Photo.DoesNotExist:
        return Response({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
    if request.method == "DELETE":
        delete_object(photo.s3_key)
        photo.delete()
        invalidate_feed()
        return Response(status=status.HTTP_204_NO_CONTENT)
    return Response(PhotoSerializer(photo).data)
