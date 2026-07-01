from azure.storage.blob import BlobServiceClient

svc = BlobServiceClient.from_connection_string("UseDevelopmentStorage=true")


def fetch_blob():
    # GET → azure://static-assets/logo.png
    return svc.get_container_client("static-assets").get_blob_client("logo.png").download_blob()


def upload_blob():
    # PUT → azure://user-uploads/inbox/new.txt
    return svc.get_container_client("user-uploads").get_blob_client("inbox/new.txt").upload_blob(b"hi")


def delete_blob():
    # DELETE → azure://archive/2026/snapshot.tar
    return svc.get_container_client("archive").get_blob_client("2026/snapshot.tar").delete_blob()


def head_blob():
    # GET (exists) → azure://static-assets/logo.png
    return svc.get_container_client("static-assets").get_blob_client("logo.png").exists()


def set_blob_metadata():
    # PUT → azure://configs/app.json
    return svc.get_container_client("configs").get_blob_client("app.json").set_blob_metadata({"k": "v"})


def list_files_in_container():
    # GET → azure://static-assets/ (container scope)
    return svc.get_container_client("static-assets").list_blobs()


def delete_container():
    # DELETE → azure://temp-container/ (container scope)
    return svc.get_container_client("temp-container").delete_container()


def create_container():
    # PUT → azure://new-container/ (container scope)
    return svc.get_container_client("new-container").create_container()


def append_block_to_blob():
    # PUT → azure://logs/system.log
    return svc.get_container_client("logs").get_blob_client("system.log").append_block(b"line\n")


def dynamic_container(name):
    # GET (dynamic container) → null URL
    return svc.get_container_client(name).get_blob_client("logo.png").download_blob()


def dynamic_blob(key):
    # GET (literal container, dynamic blob) → azure://static-assets/ (dynamic)
    return svc.get_container_client("static-assets").get_blob_client(key).download_blob()
