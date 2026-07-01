from google.cloud import storage

client = storage.Client()


def fetch_object():
    # GET → gs://static-assets/logo.png
    return client.bucket("static-assets").blob("logo.png").download_as_text()


def upload_object():
    # PUT → gs://user-uploads/inbox/new.txt
    return client.bucket("user-uploads").blob("inbox/new.txt").upload_from_string("hi")


def delete_object():
    # DELETE → gs://archive/2026/snapshot.tar
    return client.bucket("archive").blob("2026/snapshot.tar").delete()


def head_object():
    # GET (exists) → gs://static-assets/logo.png
    return client.bucket("static-assets").blob("logo.png").exists()


def patch_blob():
    # PATCH → gs://configs/app.json
    return client.bucket("configs").blob("app.json").patch()


def upload_from_filename():
    # PUT → gs://user-uploads/movie.mp4
    return client.bucket("user-uploads").blob("movie.mp4").upload_from_filename("/local/movie.mp4")


def list_files_in_bucket():
    # GET → gs://static-assets/ (bucket scope)
    return client.bucket("static-assets").list_blobs()


def delete_bucket():
    # DELETE → gs://temp-bucket/ (bucket scope)
    return client.bucket("temp-bucket").delete()


def compose_blob():
    # POST → gs://archive/composed.tar
    return client.bucket("archive").blob("composed.tar").compose([])


def make_public_blob():
    # PUT → gs://public-assets/banner.png
    return client.bucket("public-assets").blob("banner.png").make_public()


def get_signed_url():
    # GET → gs://static-assets/logo.png
    return client.bucket("static-assets").blob("logo.png").generate_signed_url(expiration=3600)


def dynamic_bucket(name):
    # GET (dynamic bucket) → null URL
    return client.bucket(name).blob("logo.png").download_as_text()


def dynamic_key(key):
    # GET (literal bucket, dynamic key) → gs://static-assets/ (dynamic confidence)
    return client.bucket("static-assets").blob(key).download_as_text()
