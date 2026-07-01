import type Parser from 'web-tree-sitter';
type SyntaxNode = Parser.SyntaxNode;
import { idFor, type APIEndpoint } from '@adorable/schema';
import type { JavaFrameworkVisitor, JavaVisitContext } from '@adorable/lang-java';

/**
 * Spring Boot framework visitor (#28).
 *
 * Detects API endpoints via Spring MVC annotations:
 *
 *   @RestController
 *   @RequestMapping("/api/users")    ← class-level prefix
 *   public class UserController {
 *     @GetMapping("/{id}")           ← method-level path
 *     public User get(Long id) {}
 *   }
 *
 * Supported method annotations:
 *   @GetMapping, @PostMapping, @PutMapping, @DeleteMapping,
 *   @PatchMapping, @RequestMapping
 *
 * Class-level @RequestMapping provides the prefix. Method-level
 * annotations provide the suffix. The composed route pattern is
 * prefix + suffix.
 *
 * Only matches files importing from `org.springframework`.
 */

const METHOD_ANNOTATIONS: Record<string, string> = {
  'GetMapping': 'GET',
  'PostMapping': 'POST',
  'PutMapping': 'PUT',
  'DeleteMapping': 'DELETE',
  'PatchMapping': 'PATCH',
};

export function createSpringVisitor(): JavaFrameworkVisitor {
  const fileImportCache = new Map<string, boolean>();

  return {
    language: 'java',
    onNode(ctx, node) {
      // We need to detect method_declaration nodes with Spring mapping annotations
      if (node.type !== 'method_declaration') return;

      if (!fileImportsSpring(node, ctx.sourceFile.filePath, fileImportCache)) return;

      // Check for mapping annotation on the method
      const methodAnnotation = findMappingAnnotation(node);
      if (!methodAnnotation) return;

      const { httpMethod, path: methodPath } = methodAnnotation;

      // Get class-level @RequestMapping prefix
      const classPrefix = findClassRequestMappingPrefix(node);

      // Compose route pattern
      const routePattern = composePath(classPrefix, methodPath);

      const endpoint: APIEndpoint = {
        nodeType: 'APIEndpoint',
        id: idFor.apiEndpoint({
          repository: ctx.sourceFile.repository,
          httpMethod,
          routePattern,
          filePath: ctx.sourceFile.filePath,
          lineStart: node.startPosition.row + 1,
        }),
        httpMethod,
        routePattern,
        handlerFunctionId: null,
        framework: 'spring',
        repository: ctx.sourceFile.repository,
        evidence: {
          filePath: ctx.sourceFile.filePath,
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          snippet: node.text.slice(0, 300),
          confidence: 'exact',
        },
      };
      ctx.emitNode(endpoint);
    },
  };
}

/**
 * Find a Spring mapping annotation on a method declaration.
 * Checks modifiers for @GetMapping, @PostMapping, etc.
 */
function findMappingAnnotation(method: SyntaxNode): { httpMethod: string; path: string } | null {
  for (let i = 0; i < method.childCount; i++) {
    const child = method.child(i)!;
    if (child.type !== 'modifiers') continue;

    for (let j = 0; j < child.childCount; j++) {
      const mod = child.child(j)!;

      // @GetMapping (no path) → marker_annotation
      if (mod.type === 'marker_annotation') {
        const name = mod.children.find((c) => c.type === 'identifier')?.text;
        if (name && name in METHOD_ANNOTATIONS) {
          return { httpMethod: METHOD_ANNOTATIONS[name], path: '' };
        }
      }

      // @GetMapping("/{id}") → annotation with argument_list
      if (mod.type === 'annotation') {
        const name = mod.children.find((c) => c.type === 'identifier')?.text;
        if (!name) continue;

        if (name in METHOD_ANNOTATIONS) {
          const path = extractAnnotationPath(mod);
          return { httpMethod: METHOD_ANNOTATIONS[name], path };
        }

        // @RequestMapping on method level
        if (name === 'RequestMapping') {
          const path = extractAnnotationPath(mod);
          const method = extractRequestMappingMethod(mod);
          return { httpMethod: method, path };
        }
      }
    }
  }
  return null;
}

/**
 * Walk up from a method to its enclosing class and find @RequestMapping prefix.
 */
function findClassRequestMappingPrefix(method: SyntaxNode): string {
  // Walk up to find the class_declaration
  let current = method.parent;
  while (current) {
    if (current.type === 'class_body') {
      current = current.parent;
      continue;
    }
    if (current.type === 'class_declaration') {
      // Check modifiers for @RequestMapping
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i)!;
        if (child.type !== 'modifiers') continue;

        for (let j = 0; j < child.childCount; j++) {
          const mod = child.child(j)!;
          if (mod.type === 'annotation') {
            const name = mod.children.find((c) => c.type === 'identifier')?.text;
            if (name === 'RequestMapping') {
              return extractAnnotationPath(mod);
            }
          }
        }
      }
      return '';
    }
    current = current.parent;
  }
  return '';
}

/**
 * Extract the path string from an annotation's argument list.
 * Handles: @GetMapping("/{id}"), @GetMapping(value = "/{id}"), @GetMapping(path = "/{id}")
 */
function extractAnnotationPath(annotation: SyntaxNode): string {
  const argList = annotation.children.find((c) => c.type === 'annotation_argument_list');
  if (!argList) return '';

  // Direct string argument: @GetMapping("/{id}")
  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i)!;
    if (child.type === 'string_literal') {
      return extractStringValue(child);
    }
    // value = "path" or path = "path"
    if (child.type === 'element_value_pair') {
      const key = child.children.find((c) => c.type === 'identifier')?.text;
      if (key === 'value' || key === 'path') {
        const val = child.children.find((c) => c.type === 'string_literal');
        if (val) return extractStringValue(val);
      }
    }
  }
  return '';
}

/**
 * Extract the HTTP method from @RequestMapping(method = RequestMethod.GET).
 * M3: Defaults to ALL when no method is specified, which matches Spring's
 * behavior — @RequestMapping without method handles all HTTP methods.
 */
function extractRequestMappingMethod(annotation: SyntaxNode): string {
  const argList = annotation.children.find((c) => c.type === 'annotation_argument_list');
  if (!argList) return 'ALL';

  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i)!;
    if (child.type === 'element_value_pair') {
      const key = child.children.find((c) => c.type === 'identifier')?.text;
      if (key === 'method') {
        const val = child.text;
        if (val.includes('GET')) return 'GET';
        if (val.includes('POST')) return 'POST';
        if (val.includes('PUT')) return 'PUT';
        if (val.includes('DELETE')) return 'DELETE';
        if (val.includes('PATCH')) return 'PATCH';
      }
    }
  }
  return 'ALL';
}

function extractStringValue(node: SyntaxNode): string {
  // string_literal contains string_fragment child with the actual text
  const fragment = node.children.find((c) => c.type === 'string_fragment');
  return fragment?.text ?? node.text.replace(/^"|"$/g, '');
}

function composePath(prefix: string, suffix: string): string {
  if (!prefix && !suffix) return '/';
  if (!prefix) return suffix.startsWith('/') ? suffix : '/' + suffix;
  if (!suffix) return prefix.startsWith('/') ? prefix : '/' + prefix;
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const s = suffix.startsWith('/') ? suffix : '/' + suffix;
  return p + s;
}

function fileImportsSpring(node: SyntaxNode, filePath: string, cache: Map<string, boolean>): boolean {
  if (cache.has(filePath)) return cache.get(filePath)!;
  const root = node.tree.rootNode;
  let has = false;
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)!;
    if (child.type === 'import_declaration' && child.text.includes('springframework')) {
      has = true;
      break;
    }
  }
  cache.set(filePath, has);
  return has;
}
