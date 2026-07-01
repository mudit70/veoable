"""Negative: no boto3 import. Visitor must not fire."""


class FakeS3:
    def get_object(self, **kwargs):
        return None


def looks_like_boto3_but_isnt():
    s3 = FakeS3()
    return s3.get_object(Bucket='nope', Key='nope.txt')
