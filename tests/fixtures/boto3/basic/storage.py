"""Fixture for framework-boto3 (S3)."""

import boto3

s3 = boto3.client('s3')


# ── Reads ──────────────────────────────────────────────────────────
def get_user_avatar(uid):
    return s3.get_object(Bucket='avatars', Key=f'users/{uid}.png')


def head_check(key):
    return s3.head_object(Bucket='avatars', Key='static.txt')


def list_recent():
    return s3.list_objects_v2(Bucket='audit-logs')


def generate_download_url():
    return s3.generate_presigned_url(
        'get_object', Params={'Bucket': 'uploads', 'Key': 'static.txt'},
    )


def generate_dynamic_url(bucket_var, key_var):
    """Identifier-valued Params entries — should stay dynamic."""
    return s3.generate_presigned_url(
        'get_object', Params={'Bucket': bucket_var, 'Key': key_var},
    )


def generate_nested_dict_url():
    """Dict-of-dict entry — should also stay dynamic."""
    return s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': {'inner': 'x'}, 'Key': 'plain.txt'},
    )


# ── Writes ─────────────────────────────────────────────────────────
def upload_avatar(uid, data):
    s3.put_object(Bucket='avatars', Key=f'users/{uid}.png', Body=data)


def copy_to_archive(src_key):
    s3.copy_object(
        Bucket='avatars-archive',
        Key='copy.png',
        CopySource={'Bucket': 'avatars', 'Key': src_key},
    )


def upload_file_positional():
    s3.upload_file('local.txt', 'uploads', 'remote.txt')


def upload_file_kwargs():
    s3.upload_file(Filename='local.txt', Bucket='uploads', Key='remote2.txt')


# ── Multipart (POST) ──────────────────────────────────────────────
def start_multipart():
    return s3.create_multipart_upload(Bucket='uploads', Key='big.bin')


# ── Deletes ────────────────────────────────────────────────────────
def delete_avatar(uid):
    s3.delete_object(Bucket='avatars', Key=f'users/{uid}.png')


def delete_many():
    s3.delete_objects(
        Bucket='audit-logs',
        Delete={'Objects': [{'Key': 'old.log'}]},
    )


# ── Dynamic bucket — variable not resolvable ───────────────────────
def dynamic_bucket_get(bucket):
    return s3.get_object(Bucket=bucket, Key='unknown.txt')


# ── Self-bound client inside a class ───────────────────────────────
class StorageService:
    def __init__(self):
        self.s3 = boto3.client('s3')

    def store(self, key, body):
        self.s3.put_object(Bucket='service-bucket', Key=key, Body=body)


# ── Download form ──────────────────────────────────────────────────
def download_file_positional():
    s3.download_file('audit-logs', 'old.log', 'local.log')


# ── Negative: dict.get(key) on something that isn't S3 ─────────────
def unrelated():
    d = {'foo': 1}
    return d.get('foo')
