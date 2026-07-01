from django.urls import include, path

urlpatterns = [
    path("api/photos/", include("photos.urls")),
]
