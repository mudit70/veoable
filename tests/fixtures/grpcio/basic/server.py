"""Fixture for framework-grpcio (Python gRPC server-side)."""

import grpc
from concurrent import futures
from . import helloworld_pb2
from . import helloworld_pb2_grpc


# Canonical: class inherits from a generated `<Service>Servicer` via
# a scoped path `pb2_grpc.GreeterServicer`. Service name = "Greeter".
class Greeter(helloworld_pb2_grpc.GreeterServicer):
    def SayHello(self, request, context):
        return helloworld_pb2.HelloReply(message=f"Hello {request.name}")

    def SayGoodbye(self, request, context):
        return helloworld_pb2.GoodbyeReply(message=f"Bye {request.name}")

    async def ListUsersStream(self, request, context):
        for name in ("a", "b"):
            yield helloworld_pb2.UserReply(name=name)


# Bare-form parent (no scoped prefix). Service name = "Echo".
class EchoServer(EchoServicer):
    def Echo(self, request, context):
        return helloworld_pb2.EchoReply(message=request.message)


# Two servicers in one class via multiple inheritance — emit for BOTH
# bases. The visitor picks the FIRST `*Servicer` superclass; the
# second is a separate API surface that a more advanced version
# could pick up. v1: only the first is registered. We use the second
# servicer here as a known limitation marker (no negative emit).
class MultiBase(GreeterServicer, EchoServicer):
    def SayHello(self, request, context):
        return None


# Negative: a class that ISN'T a Servicer. No emits.
class HelperUtil:
    def helper_method(self):
        return 1


# Negative: a class that LOOKS like a servicer but the suffix is wrong.
class GreeterServicing:  # Not "Servicer"
    def NotARpc(self, request, context):
        return None


# Negative: dunder methods on a real servicer are skipped. This
# class DOES inherit from a `*Servicer` base, so the visitor's
# inheritance gate passes; the dunder skip is what we're testing.
class Widget(WidgetServicer):
    def __init__(self):
        self._n = 0

    def MakeWidget(self, request, context):
        return None


def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    helloworld_pb2_grpc.add_GreeterServicer_to_server(Greeter(), server)
    server.add_insecure_port("[::]:50051")
    server.start()
    server.wait_for_termination()
