"""Negative fixture: no httpx/requests import — method calls here
must NOT emit ClientSideAPICaller, even if the receiver name matches
the heuristic."""


def deceiving():
    class FakeClient:
        def get(self, _url):
            return None

    client = FakeClient()
    return client.get("https://api.example.com/nope")
