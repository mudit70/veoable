export { TsLanguagePlugin, TS_PLUGIN_ID, TS_FILE_EXTENSIONS } from './ts-language-plugin.js';
export type { TsFrameworkVisitor, TsVisitContext } from './framework-visitor.js';
export { buildEvidence } from './evidence.js';
export { readStringLiteral } from './string-literal.js';
export {
  resolveToString,
  resolveUrlPattern,
  resolveCallerUrl,
  reconstructFromParts,
  detectExternalUrl,
  type UrlPattern,
  type CallerUrlInfo,
} from './resolve-constant.js';
export { resolveHandlerToFunctionId } from './resolve-handler.js';
export { findUniqueExportedDeclaration } from './find-exported-declaration.js';
export {
  resolveIdentifierTypeToDeclaration,
  resolveImportedDeclarations,
  resolveNamespaceImportProperty,
} from './cross-file-resolver.js';
export { emitTemplateRenderScreens, type EmitRenderConfig } from './emit-render.js';
export { SERVE_HANDLER_SUFFIX } from './extract-source-file.js';
export { resolveFunctionDefinitionIdFromDecl } from './resolve-function-id.js';
