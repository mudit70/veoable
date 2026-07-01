import { idFor, type APIEndpoint, type DatabaseInteraction, type DatabaseTable, type DatabaseOperation } from '@veoable/schema';
import type { PyFrameworkVisitor, PyVisitContext } from '@veoable/lang-py';
import type Parser from 'web-tree-sitter';
import type { DjangoUrlMap } from './urls-resolver.js';
type SyntaxNode = Parser.SyntaxNode;

/**
 * Django REST Framework visitor (#43).
 *
 * Detects:
 *   1. ViewSet methods (list, create, retrieve, update, destroy, custom @action)
 *      → APIEndpoint nodes with route patterns from urlpatterns/router
 *   2. Django ORM operations:
 *      Model.objects.all/filter/get → read
 *      serializer.save(), Model.objects.create → write
 *      instance.delete() → delete
 *      instance.save() → write
 */

const ORM_READ_METHODS: ReadonlySet<string> = new Set([
  'all', 'filter', 'get', 'first', 'last', 'count', 'exists',
  'values', 'values_list', 'order_by', 'distinct', 'aggregate',
  'annotate', 'select_related', 'prefetch_related', 'exclude',
]);

const ORM_WRITE_METHODS: ReadonlySet<string> = new Set([
  'create', 'update', 'bulk_create', 'bulk_update', 'get_or_create',
  'update_or_create',
]);

const ORM_DELETE_METHODS: ReadonlySet<string> = new Set([
  'delete',
]);

export function createDjangoVisitor(
  systemId: string,
  urlMap?: DjangoUrlMap,
): PyFrameworkVisitor {
  const emittedTables = new Set<string>();

  return {
    language: 'py',

    onNode(ctx, node) {
      // Detect Django ORM calls: Model.objects.method()
      if (node.type === 'call') {
        detectOrmCall(ctx, node, systemId, emittedTables);
        // Also detect instance.save() and instance.delete()
        detectInstanceMutation(ctx, node, systemId, emittedTables);
        // Detect serializer.save()
        detectSerializerSave(ctx, node, systemId, emittedTables);
        return;
      }

      // Detect class-based views that extend ViewSet
      if (node.type === 'class_definition') {
        detectViewSetEndpoints(ctx, node, urlMap);
      }

      // Detect `@api_view([...])` decorated function-based views.
      if (node.type === 'decorated_definition') {
        detectApiViewEndpoints(ctx, node, urlMap);
      }
    },
  };
}

/**
 * Detect DRF `@api_view(['GET', 'POST'])` decorators on function-based
 * views and emit one APIEndpoint per HTTP method × route combo.
 *
 *   @api_view(['GET', 'POST'])
 *   def list_create_photos(request):
 *       ...
 *
 * The route is looked up in `urlMap.functionRoute` (built from
 * `path("...", views.func_name)` declarations across the project's
 * urls.py files). If no URL mapping is found, we still emit one
 * endpoint per HTTP method with the function name as a synthetic
 * route — this keeps the function visible in the graph.
 */
function detectApiViewEndpoints(
  ctx: PyVisitContext,
  node: SyntaxNode,
  urlMap?: DjangoUrlMap,
): void {
  const def = findFunctionDef(node);
  if (!def) return;
  const funcNameNode = def.childForFieldName('name');
  if (!funcNameNode) return;
  const funcName = funcNameNode.text;

  const decorators = collectDecorators(node);
  const methods = collectApiViewMethods(decorators);
  if (methods.length === 0) return;

  const route = urlMap?.functionRoute.get(funcName) ?? `/${funcName}`;
  const evidenceLine = def.startPosition.row + 1;
  // Compute the handler's FunctionDefinition id directly. We cannot
  // rely on `ctx.enclosingFunction` because tree-sitter dispatches
  // `decorated_definition` *before* the contained function is pushed
  // onto the walker's function stack — so `enclosingFunction` here
  // is the outer scope, not the @api_view function itself. This
  // mirrors what `detectViewSetEndpoints` already does for class-
  // based views.
  const handlerFunctionId = idFor.functionDefinition({
    sourceFileId: ctx.sourceFile.id,
    name: funcName,
    sourceLine: evidenceLine,
  });

  for (const httpMethod of methods) {
    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: ctx.sourceFile.repository,
        httpMethod,
        routePattern: route,
        filePath: ctx.sourceFile.filePath,
        lineStart: evidenceLine,
      }),
      httpMethod,
      routePattern: route,
      handlerFunctionId,
      framework: 'django',
      repository: ctx.sourceFile.repository,
      evidence: {
        filePath: ctx.sourceFile.filePath,
        lineStart: evidenceLine,
        lineEnd: def.endPosition.row + 1,
        snippet: def.text.slice(0, 200),
        confidence: urlMap?.functionRoute.has(funcName) ? 'exact' : 'heuristic',
      },
    };
    ctx.emitNode(endpoint);
  }
}

function findFunctionDef(node: SyntaxNode): SyntaxNode | null {
  const def = node.childForFieldName('definition');
  if (def && def.type === 'function_definition') return def;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === 'function_definition') return c;
  }
  return null;
}

function collectDecorators(decoratedNode: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < decoratedNode.childCount; i++) {
    const c = decoratedNode.child(i);
    if (c && c.type === 'decorator') out.push(c);
  }
  return out;
}

/**
 * Match `@api_view([...])` or `@api_view(http_method_names=[...])` and
 * return the upper-case HTTP methods. Returns `[]` when no `@api_view`
 * decorator is present.
 */
function collectApiViewMethods(decorators: readonly SyntaxNode[]): string[] {
  for (const dec of decorators) {
    const text = dec.text;
    if (!/@api_view\b/.test(text)) continue;
    const out: string[] = [];
    const re = /["']([A-Za-z]+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const verb = m[1].toUpperCase();
      if (!out.includes(verb)) out.push(verb);
    }
    return out;
  }
  return [];
}

function detectOrmCall(
  ctx: PyVisitContext,
  node: SyntaxNode,
  systemId: string,
  emittedTables: Set<string>,
): void {
  if (!ctx.enclosingFunction) return;

  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return;

  const methodName = fn.childForFieldName('attribute')?.text;
  if (!methodName) return;

  const obj = fn.childForFieldName('object');
  if (!obj) return;

  // Pattern: Model.objects.method() or queryset.method()
  // obj is either: attribute (Model.objects) or identifier (queryset variable)
  if (obj.type === 'attribute') {
    const manager = obj.childForFieldName('attribute')?.text;
    const model = obj.childForFieldName('object')?.text;
    if (manager === 'objects' && model && /^[A-Z]/.test(model)) {
      let operation: DatabaseOperation | null = null;
      if (ORM_READ_METHODS.has(methodName)) operation = 'read';
      else if (ORM_WRITE_METHODS.has(methodName)) operation = 'write';
      else if (ORM_DELETE_METHODS.has(methodName)) operation = 'delete';
      if (operation) {
        emitDbInteraction(ctx, node, operation, model, systemId, emittedTables);
      }
    }
  }
}

function detectInstanceMutation(
  ctx: PyVisitContext,
  node: SyntaxNode,
  systemId: string,
  emittedTables: Set<string>,
): void {
  if (!ctx.enclosingFunction) return;

  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return;

  const methodName = fn.childForFieldName('attribute')?.text;
  if (methodName !== 'save' && methodName !== 'delete') return;

  const obj = fn.childForFieldName('object');
  if (!obj || obj.type !== 'identifier') return;

  // instance.save() or instance.delete() — infer model from variable name
  // Convert snake_case to PascalCase: my_article → MyArticle, article → Article
  const varName = obj.text;
  if (varName === 'self' || varName === 'serializer') return;
  const modelName = varName.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');

  const operation: DatabaseOperation = methodName === 'delete' ? 'delete' : 'write';
  emitDbInteraction(ctx, node, operation, modelName, systemId, emittedTables);
}

function detectSerializerSave(
  ctx: PyVisitContext,
  node: SyntaxNode,
  systemId: string,
  emittedTables: Set<string>,
): void {
  if (!ctx.enclosingFunction) return;

  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'attribute') return;

  const methodName = fn.childForFieldName('attribute')?.text;
  if (methodName !== 'save') return;

  const obj = fn.childForFieldName('object');
  if (!obj) return;

  // serializer.save() — try to infer model from the enclosing class's queryset
  const objText = obj.text;
  if (objText === 'serializer' || objText.endsWith('_serializer')) {
    // Look at the enclosing function name to guess the model
    const fnName = ctx.enclosingFunction?.name ?? '';
    // perform_create in ArticleViewSet → Article
    const className = fnName.split('.')[0] ?? '';
    const modelName = className.replace(/ViewSet$/, '').replace(/View$/, '');
    if (modelName && /^[A-Z]/.test(modelName)) {
      emitDbInteraction(ctx, node, 'write', modelName, systemId, emittedTables);
    }
  }
}

function detectViewSetEndpoints(ctx: PyVisitContext, node: SyntaxNode, urlMap?: DjangoUrlMap): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const className = nameNode.text;

  // Check if it extends ModelViewSet or ViewSet
  const superclasses = node.childForFieldName('superclasses');
  if (!superclasses) return;

  const superText = superclasses.text;
  if (!superText.includes('ViewSet') && !superText.includes('ModelViewSet') && !superText.includes('APIView')) return;

  // #221 — prefer the composed prefix from urls.py router.register()
  // + path('<prefix>', include('<app>.urls')) chain when available.
  // Fall back to the class-name heuristic when no urls.py info is
  // present (or this ViewSet wasn't router-registered).
  let prefix: string | null = urlMap?.viewSetPrefix.get(className) ?? null;
  if (!prefix) {
    const baseName = className.replace(/ViewSet$/, '').replace(/View$/, '').toLowerCase();
    // Basic pluralization: category → categories, article → articles
    const plural = baseName.endsWith('y')
      ? baseName.slice(0, -1) + 'ies'
      : baseName.endsWith('s') || baseName.endsWith('x') || baseName.endsWith('z')
        ? baseName + 'es'
        : baseName + 's';
    // Convention: DRF routers mount at /api/<resource>/
    prefix = `/api/${plural}`;
  }

  const classLine = node.startPosition.row + 1;
  const body = node.childForFieldName('body');
  const methods: Array<{ http: string; route: string; handler: string; line: number }> = [
    { http: 'GET', route: prefix, handler: 'list', line: classLine },
    { http: 'POST', route: prefix, handler: 'create', line: classLine },
    { http: 'GET', route: `${prefix}/:id`, handler: 'retrieve', line: classLine },
    { http: 'PUT', route: `${prefix}/:id`, handler: 'update', line: classLine },
    { http: 'DELETE', route: `${prefix}/:id`, handler: 'destroy', line: classLine },
  ];

  // Override line numbers for methods explicitly defined, and detect custom @action methods.
  if (body) {
    for (const child of body.children) {
      const fnDef = child.type === 'function_definition' ? child
        : child.type === 'decorated_definition' ? child.childForFieldName('definition') : null;
      if (fnDef?.type === 'function_definition') {
        const methodName = fnDef.childForFieldName('name')?.text;
        const entry = methods.find((m) => m.handler === methodName);
        if (entry) entry.line = fnDef.startPosition.row + 1;
      }
    }

    // Detect custom @action methods.
    for (const child of body.children) {
      if (child.type === 'decorated_definition') {
        const decorators = child.children.filter((c) => c.type === 'decorator');
        const fnDef = child.childForFieldName('definition');
        for (const dec of decorators) {
          const actionInfo = parseActionDecorator(dec);
          if (actionInfo && fnDef?.type === 'function_definition') {
            const actionName = fnDef.childForFieldName('name')?.text ?? 'action';
            const actionLine = fnDef.startPosition.row + 1;
            for (const method of actionInfo.methods) {
              methods.push({
                http: method.toUpperCase(),
                route: actionInfo.detail ? `${prefix}/:id/${actionName}` : `${prefix}/${actionName}`,
                handler: actionName,
                line: actionLine,
              });
            }
          }
        }
      }
    }
  }

  for (const m of methods) {
    const handlerFnId = idFor.functionDefinition({
      sourceFileId: ctx.sourceFile.id,
      name: `${className}.${m.handler}`,
      sourceLine: m.line,
    });

    const endpoint: APIEndpoint = {
      nodeType: 'APIEndpoint',
      id: idFor.apiEndpoint({
        repository: ctx.sourceFile.repository,
        httpMethod: m.http,
        routePattern: m.route,
        filePath: ctx.sourceFile.filePath,
        lineStart: m.line,
      }),
      httpMethod: m.http,
      routePattern: m.route,
      handlerFunctionId: handlerFnId,
      framework: 'django',
      repository: ctx.sourceFile.repository,
    };
    ctx.emitNode(endpoint);
  }
}

function parseActionDecorator(decorator: SyntaxNode): { detail: boolean; methods: string[] } | null {
  for (const child of decorator.children) {
    if (child.type === 'call') {
      const fn = child.childForFieldName('function');
      if (fn?.type !== 'identifier' || fn.text !== 'action') return null;

      let detail = false;
      const methods: string[] = ['get'];
      const args = child.childForFieldName('arguments');
      if (args) {
        for (const arg of args.children) {
          if (arg.type === 'keyword_argument') {
            const key = arg.childForFieldName('name')?.text;
            const value = arg.childForFieldName('value');
            if (key === 'detail' && value?.text === 'True') detail = true;
            if (key === 'methods' && value?.type === 'list') {
              methods.length = 0;
              for (const item of value.children) {
                if (item.type === 'string') methods.push(item.text.replace(/['"]/g, ''));
              }
            }
          }
        }
      }
      return { detail, methods };
    }
  }
  return null;
}

function emitDbInteraction(
  ctx: PyVisitContext,
  node: SyntaxNode,
  operation: DatabaseOperation,
  modelName: string,
  systemId: string,
  emittedTables: Set<string>,
): void {
  if (!ctx.enclosingFunction) return;

  const tableName = modelName.toLowerCase();
  const tableId = idFor.databaseTable({ systemId, schema: null, name: tableName });

  if (!emittedTables.has(tableId)) {
    emittedTables.add(tableId);
    const table: DatabaseTable = {
      nodeType: 'DatabaseTable', id: tableId, systemId, name: tableName,
      schema: null, kind: 'table', declaredIn: null,
    };
    ctx.emitNode(table);
    ctx.emitEdge({ edgeType: 'TABLE_IN', from: tableId, to: systemId });
  }

  const interaction: DatabaseInteraction = {
    nodeType: 'DatabaseInteraction',
    id: idFor.databaseInteraction({
      callSiteFunctionId: ctx.enclosingFunction.id,
      operation,
      targetTableId: tableId,
    }),
    callSiteFunctionId: ctx.enclosingFunction.id,
    operation, orm: 'django', rawQuery: null, confidence: 'inferred',
  };
  ctx.emitNode(interaction);

  if (operation === 'read') {
    ctx.emitEdge({ edgeType: 'READS', from: interaction.id, to: tableId, columns: null, filters: null });
  } else {
    const kind = operation === 'delete' ? 'delete' : operation === 'update' ? 'update' : 'insert';
    ctx.emitEdge({ edgeType: 'WRITES', from: interaction.id, to: tableId, columns: null, kind });
  }

  ctx.emitEdge({
    edgeType: 'PERFORMED_BY', from: interaction.id, to: ctx.enclosingFunction.id,
    sourceLine: node.startPosition.row + 1,
  });
}
