import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import type { TsFrameworkVisitor } from '@veoable/lang-ts';
import { createReactNativeVisitor } from './visitor.js';

/**
 * React Native framework plugin (#167).
 *
 * Detects client-side processes in React Native applications:
 *   - JSX event handlers: onPress, onLongPress, onPressIn, onPressOut,
 *     onScroll, onRefresh, onEndReached (RN-specific events)
 *   - React lifecycle hooks: useEffect, useLayoutEffect (same as React web)
 *   - Navigation calls: navigation.navigate(), .push(), .goBack()
 *
 * Mutual exclusion: when react-native is detected, this plugin takes
 * over from framework-react. Both detect the same JSX patterns but
 * this plugin stamps framework: 'react-native' and adds RN-specific
 * navigation detection.
 *
 * Activates when react-native or expo is in dependencies.
 */
export const REACT_NATIVE_PLUGIN_ID = 'react-native' as const;

export class ReactNativePlugin implements FrameworkPlugin {
  readonly id = REACT_NATIVE_PLUGIN_ID;
  readonly language = 'ts';

  appliesTo(ctx: ProjectContext): boolean {
    const pkg = ctx.packageJson ?? {};
    const deps = {
      ...((pkg as { dependencies?: Record<string, string> }).dependencies ?? {}),
      ...((pkg as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
      ...((pkg as { peerDependencies?: Record<string, string> }).peerDependencies ?? {}),
    };
    return 'react-native' in deps || 'expo' in deps;
  }

  readonly visitor: TsFrameworkVisitor = createReactNativeVisitor();
}
