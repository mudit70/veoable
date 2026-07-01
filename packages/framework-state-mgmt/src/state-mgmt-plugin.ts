import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createStateMgmtVisitor } from './visitor.js';

/**
 * State management framework plugin (#61).
 *
 * Detects client-side processes originating from state management
 * libraries:
 *   - Redux Toolkit: createAsyncThunk, createSlice extraReducers
 *   - Zustand: store action methods with async operations
 *   - MobX: action/flow decorators, autorun, reaction
 *   - Pinia: defineStore actions
 *
 * These patterns represent the bridge between UI events and API
 * callers — the UI dispatches an action/mutation which triggers
 * async work in the store.
 *
 * Stateless — the same plugin instance can analyze any number of
 * projects without reset.
 */
export const STATE_MGMT_PLUGIN_ID = 'state-mgmt' as const;

export class StateMgmtPlugin implements FrameworkPlugin {
  readonly id = STATE_MGMT_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return (
      '@reduxjs/toolkit' in deps ||
      'redux' in deps ||
      'zustand' in deps ||
      'mobx' in deps ||
      'pinia' in deps
    );
  }

  readonly visitor: TsFrameworkVisitor = createStateMgmtVisitor();
}
