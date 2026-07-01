// Fixture for framework-grpcgo (Go gRPC server-side).
package main

import (
	"context"

	pb "example.com/helloworld"
	"google.golang.org/grpc"
)

// ── Canonical: struct embeds a scoped Unimplemented*Server ─────────
// Service name = "Greeter".
type greeterServer struct {
	pb.UnimplementedGreeterServer
}

func (s *greeterServer) SayHello(ctx context.Context, req *pb.HelloRequest) (*pb.HelloReply, error) {
	return &pb.HelloReply{Message: "Hello " + req.Name}, nil
}

func (s *greeterServer) SayGoodbye(ctx context.Context, req *pb.GoodbyeRequest) (*pb.GoodbyeReply, error) {
	return &pb.GoodbyeReply{Message: "Bye " + req.Name}, nil
}

// Server-streaming RPC — different shape, still an RPC.
func (s *greeterServer) ListUsersStream(req *pb.ListUsersRequest, stream pb.Greeter_ListUsersStreamServer) error {
	return nil
}

// ── Bare embed (no scoped prefix) — Service name = "Echo" ──────────
type echoServer struct {
	UnimplementedEchoServer
}

func (s *echoServer) Echo(ctx context.Context, req *pb.EchoRequest) (*pb.EchoReply, error) {
	return &pb.EchoReply{Message: req.Message}, nil
}

// ── Negative: struct WITHOUT embedded Unimplemented*Server ─────────
type plainStruct struct {
	name string
}

func (p *plainStruct) PlainMethod() string { return p.name }

// ── Negative: struct that embeds something that LOOKS like a
// servicer but isn't (no `Unimplemented` prefix or no `Server`
// suffix).
type lookalikeServer struct {
	UnimplementedThingy   // No `Server` suffix — must NOT match
}

func (l *lookalikeServer) NotAnRpc(ctx context.Context) error { return nil }

type anotherLookalike struct {
	GreeterServer   // No `Unimplemented` prefix — must NOT match
}

func (a *anotherLookalike) AlsoNotAnRpc() {}

// ── Multi-embed: struct embeds two `Unimplemented*Server` types ────
// Each method emits TWICE — once per service base.
type multiBase struct {
	pb.UnimplementedGreeterServer
	UnimplementedEchoServer
}

func (m *multiBase) DualMethod(ctx context.Context, req *pb.HelloRequest) (*pb.HelloReply, error) {
	return nil, nil
}

// ── Non-pointer receiver on a real servicer — should still emit ────
type widgetServer struct {
	UnimplementedWidgetServer
}

func (w widgetServer) MakeWidget(ctx context.Context, req *pb.WidgetRequest) (*pb.WidgetReply, error) {
	return nil, nil
}

func main() {
	server := grpc.NewServer()
	pb.RegisterGreeterServer(server, &greeterServer{})
	_ = server
}
