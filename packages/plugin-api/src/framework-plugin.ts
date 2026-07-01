import type { NodeBatch } from '@veoable/schema';
import type { FrameworkVisitor } from './language-plugin.js';
import type { ProjectContext } from './types.js';

/**
 * A framework plugin detects framework-specific constructs (routes,
 * handlers, API callers, ORM call sites, …) by registering AST visitors
 * with a language plugin. It is always bound to exactly one language but
 * is stack-agnostic — a single framework plugin like "express" works for
 * any project that uses Express regardless of what the frontend is.
 *
 * Stacks are runtime compositions: the orchestrator loads the language
 * plugin that matches each file extension and asks every framework plugin
 * whose `language` matches whether it `appliesTo` the current project.
 * Every plugin that returns `true` has its visitor registered.
 */
export interface FrameworkPlugin {
  /**
   * Stable id, e.g. `'express'`, `'react'`, `'prisma'`, `'fastapi'`.
   * Used for attribution in `BatchMeta.producedBy` and for
   * deduplication across framework plugins that detect the same concept.
   */
  readonly id: string;

  /**
   * The language plugin id this framework plugin binds to. Must match a
   * loaded `LanguagePlugin.id`.
   */
  readonly language: string;

  /**
   * Runtime check whether this plugin applies to the current project.
   * Typical implementations inspect `ctx.packageJson.dependencies` for a
   * framework package name or check `ctx.files` for a convention-based
   * marker directory.
   */
  appliesTo(ctx: ProjectContext): boolean;

  /**
   * The visitor that will be registered with the language plugin if
   * `appliesTo` returns true. Its concrete shape is defined by the
   * target language plugin and should be imported from that plugin's
   * public API, not from `@veoable/plugin-api`.
   */
  readonly visitor: FrameworkVisitor;

  /**
   * Optional hook invoked once per project after `appliesTo` has
   * returned true and before any `extractFile` call. Framework plugins
   * that need to process files the language plugin does NOT own
   * (schema files, config files, IDL files, migration folders, …)
   * return the resulting `NodeBatch` here. The orchestrator commits it
   * to the graph store just like a file-level batch.
   *
   * The hook exists so ORM / schema-bearing plugins (Prisma, SQLAlchemy,
   * Django models, JPA entities, GORM struct tags, …) don't each
   * invent a side-channel method for "extract from files I own."
   * Implementors that don't need project-level extraction simply omit
   * the method.
   *
   * Called exactly once per project load. If the hook throws, the
   * failure propagates out through the orchestrator — a buggy
   * framework plugin fails loud.
   */
  onProjectLoaded?(ctx: ProjectContext): NodeBatch | Promise<NodeBatch>;
}
