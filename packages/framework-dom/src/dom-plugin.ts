import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createDomVisitor } from './visitor.js';

/**
 * Vanilla-DOM framework plugin (#306).
 *
 * Detects client-side processes originating from direct DOM
 * `addEventListener` calls — the canonical interactivity model for
 * any frontend that doesn't ride a JSX/SFC-based framework:
 *   - framework-less SPAs
 *   - browser extensions
 *   - custom-elements apps (Web Components)
 *   - progressive-enhancement layers atop server-rendered HTML
 *   - jQuery-era code being incrementally migrated
 *
 * Detection shape:
 *
 *   <element>.addEventListener('event', handler)
 *   <element>.addEventListener('event', this.handler.bind(this))
 *   <element>.addEventListener('event', () => {...})
 *
 * Emits `ClientSideProcess(kind: 'event_handler', name: '<event>')`
 * and a TRIGGERS edge to the resolved handler function.
 *
 * ## Why this is a plugin, not lang-ts
 *
 * `addEventListener` is a DOM Web API — a framework, not a language
 * primitive. CLAUDE.md's "split parsers by language" invariant
 * applies to AST walks; this is a specific-shape detector that
 * registers as a TsFrameworkVisitor and shares the lang-ts walk.
 * Lifting it into lang-ts would couple the language plugin to a
 * specific platform.
 *
 * ## Always-on activation
 *
 * Unlike framework-specific plugins (Express, NestJS, ...), the DOM
 * has no `package.json` marker — any TS project may use it. We
 * activate when:
 *   - The project's package.json declares any browser-runtime
 *     framework (`react`, `vue`, `svelte`, etc.), since they
 *     commonly use `addEventListener` for non-managed DOM, OR
 *   - The package.json has NO server-only runtime dependency
 *     (no Express, no Fastify, no NestJS, ...) — typical of
 *     vanilla SPA / static-site / extension layouts.
 *
 * The activation is intentionally generous; the visitor is shape-
 * narrow (only `.addEventListener('literal', fn)` calls), so
 * false positives are unlikely.
 */
export const DOM_PLUGIN_ID = 'dom' as const;

const BROWSER_RUNTIME_HINTS: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'react-native',
  'vue',
  'svelte',
  '@angular/core',
  'lit',
  '@webcomponents/custom-elements',
  'preact',
  'solid-js',
  'alpinejs',
  'htmx.org',
]);

const SERVER_ONLY_RUNTIME_HINTS: ReadonlySet<string> = new Set([
  'express',
  'fastify',
  '@nestjs/core',
  'koa',
  '@hapi/hapi',
  'hono',
]);

export class DomPlugin implements FrameworkPlugin {
  readonly id = DOM_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    const declares = (set: ReadonlySet<string>): boolean => {
      for (const name of set) if (name in deps) return true;
      return false;
    };
    if (declares(BROWSER_RUNTIME_HINTS)) return true;
    // No browser-runtime hint AND no server-runtime hint — most
    // likely a vanilla TS frontend, custom-elements app, or
    // browser extension. Activate.
    return !declares(SERVER_ONLY_RUNTIME_HINTS);
  }

  readonly visitor: TsFrameworkVisitor = createDomVisitor();
}
