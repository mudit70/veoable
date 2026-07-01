// Edge Function where serve(...) is invoked from inside a wrapper
// function (rare but legal). The handler arrow's name resolves to
// `bootstrap.serve$handler`, NOT `<module>.serve$handler`. The visitor
// must use the enclosing function's name as the prefix to keep
// FunctionDefinition.id consistent.
declare const serve: (handler: (req: Request) => Response | Promise<Response>) => void;

function bootstrap() {
  serve(async (req) => {
    return new Response('wrapped');
  });
}

bootstrap();
