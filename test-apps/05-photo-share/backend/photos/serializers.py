from rest_framework import serializers
from django.conf import settings
from .models import Photo


class PhotoSerializer(serializers.ModelSerializer):
    imageUrl = serializers.SerializerMethodField()
    s3Key = serializers.CharField(source="s3_key")
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    uploaderId = serializers.CharField(source="uploader_id")

    class Meta:
        model = Photo
        fields = ["id", "caption", "s3Key", "imageUrl", "uploaderId", "createdAt"]

    def get_imageUrl(self, obj):
        return f"https://{settings.S3_BUCKET}.s3.{settings.S3_REGION}.amazonaws.com/{obj.s3_key}"
