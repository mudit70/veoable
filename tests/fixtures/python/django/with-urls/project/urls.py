from django.urls import path, include

urlpatterns = [
    path('api/v2/', include('myapp.urls')),
]
