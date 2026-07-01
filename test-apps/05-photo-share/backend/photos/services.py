import json
import uuid
import boto3
import redis
from django.conf import settings

FEED_CACHE_KEY = "feed:recent"
FEED_CACHE_TTL = 30  # seconds

_s3 = boto3.client("s3", region_name=settings.S3_REGION)
_redis = redis.Redis.from_url(settings.REDIS_URL, decode_responses=True)


def presign_upload(content_type: str) -> dict:
    key = f"uploads/{uuid.uuid4()}.jpg"
    url = _s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.S3_BUCKET,
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=300,
    )
    return {"uploadUrl": url, "s3Key": key}


def delete_object(s3_key: str) -> None:
    _s3.delete_object(Bucket=settings.S3_BUCKET, Key=s3_key)


def cached_feed():
    raw = _redis.get(FEED_CACHE_KEY)
    return json.loads(raw) if raw else None


def store_feed_cache(payload) -> None:
    _redis.set(FEED_CACHE_KEY, json.dumps(payload), ex=FEED_CACHE_TTL)


def invalidate_feed() -> None:
    _redis.delete(FEED_CACHE_KEY)
