# Veoable

## Architecture invariants

Two load-bearing rules. Drift here is expensive and recurring.

1. **Split parsers by language, not by framework.** One LanguagePlugin per language owns the
   AST walk (lang-ts, lang-py, lang-go, ...). All FrameworkPlugins targeting that language
   register visitors that share the single walk. A framework plugin must NEVER instantiate
   its own parser (`new Project()` from ts-morph, libcst, tree-sitter, etc.) for source files
   in that language. If you find yourself wanting to, extend the LanguagePlugin's visitor
   context with a helper so every framework plugin benefits.
   Sanctioned exception: `FrameworkPlugin.onProjectLoaded` may parse files the language
   plugin does NOT claim (Prisma schemas, Django models, OpenAPI specs, webpack configs).

2. **Split graphs by repository.** Multi-repo projects analyze each repo independently and
   stitch results in the flow-stitcher layer. Don't share AST state across repos.

Cross-cutting concerns (cross-file symbol resolution, manifest discovery, constant
propagation, workspace-alias resolution) belong in the language plugin or in plugin-api,
NOT duplicated across framework plugins. Three frameworks each implementing the same
resolution logic is a smell — extract it down one layer.
