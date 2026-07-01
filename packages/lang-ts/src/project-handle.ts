import type { Project } from 'ts-morph';
import type { ProjectHandle } from '@adorable/plugin-api';

/**
 * Internal-only struct that backs the opaque `ProjectHandle` returned
 * from `TsLanguagePlugin.loadProject`. The `ProjectHandle` brand is a
 * `unique symbol` from `@adorable/plugin-api` so callers cannot construct
 * one; the only way to obtain a usable handle is to go through the
 * plugin's `loadProject` method, which gives the plugin sole control of
 * the underlying ts-morph `Project` lifetime.
 */
export interface TsProjectInternal {
  project: Project;
  /** Absolute path to the project root, normalized. */
  rootDir: string;
  /** Repository identifier — derived from `rootDir`'s basename for now. */
  repository: string;
}

const HANDLE_TO_INTERNAL = new WeakMap<object, TsProjectInternal>();

/** Wrap a `TsProjectInternal` as an opaque `ProjectHandle`. */
export function wrapHandle(internal: TsProjectInternal): ProjectHandle {
  // The handle is just an empty object whose identity is the lookup key.
  // The brand on `ProjectHandle` is structural-only at the type level;
  // at runtime the WeakMap is what actually enforces opacity.
  const handle = {} as ProjectHandle;
  HANDLE_TO_INTERNAL.set(handle, internal);
  return handle;
}

/** Unwrap a `ProjectHandle` previously created by `wrapHandle`. */
export function unwrapHandle(handle: ProjectHandle): TsProjectInternal {
  const internal = HANDLE_TO_INTERNAL.get(handle);
  if (!internal) {
    throw new Error(
      '@adorable/lang-ts: ProjectHandle was not produced by TsLanguagePlugin.loadProject. ' +
        'Plugins must use the handle returned from loadProject; do not forge one.'
    );
  }
  return internal;
}
