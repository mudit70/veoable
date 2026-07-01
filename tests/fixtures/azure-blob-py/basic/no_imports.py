class FakeBlob:
    def download_blob(self): return None
    def upload_blob(self, data): return None
    def delete_blob(self): return None


class FakeContainer:
    def get_blob_client(self, key): return FakeBlob()


class FakeSvc:
    def get_container_client(self, name): return FakeContainer()


svc = FakeSvc()


def local_fetch():
    return svc.get_container_client("nope").get_blob_client("nope").download_blob()


def local_save():
    return svc.get_container_client("nope").get_blob_client("nope").upload_blob(b"x")
