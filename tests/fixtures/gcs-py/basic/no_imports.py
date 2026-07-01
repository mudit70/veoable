class FakeBlob:
    def download_as_text(self): return ""
    def upload_from_string(self, s): pass
    def delete(self): pass


class FakeBucket:
    def blob(self, key): return FakeBlob()


class FakeClient:
    def bucket(self, name): return FakeBucket()


client = FakeClient()


def local_fetch():
    return client.bucket("nope").blob("nope").download_as_text()


def local_save():
    return client.bucket("nope").blob("nope").upload_from_string("x")
