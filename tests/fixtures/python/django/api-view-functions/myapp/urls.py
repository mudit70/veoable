from django.urls import path

from . import views

urlpatterns = [
    path("", views.list_create_photos),
    path("upload-url", views.request_upload_url),
    path("<uuid:photo_id>", views.photo_detail),
    path("<int:pk>/audit", views.audit_log),
    path("<slug:tag>", views.tag_lookup),
]
