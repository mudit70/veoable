import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasMavenArtifact } from '@veoable/plugin-api';
import type { JavaFrameworkVisitor } from '@veoable/lang-java';
import { createSpringVisitor } from './visitor.js';

/**
 * Spring Boot framework plugin (#28).
 *
 * Detects API endpoints declared via Spring MVC annotations:
 *   @GetMapping, @PostMapping, @PutMapping, @DeleteMapping, @PatchMapping
 *   @RequestMapping (class-level prefix and method-level)
 *
 * Activates when pom.xml or build.gradle contains spring-boot.
 */
export const SPRING_PLUGIN_ID = 'spring' as const;

export class SpringPlugin implements FrameworkPlugin {
  readonly id = SPRING_PLUGIN_ID;
  readonly language = 'java';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.java'))) return false;
    // Primary: any pom.xml or build.gradle in the tree declares a
    // spring-boot artifact (#203 — works on Maven multi-module
    // monorepos where Spring Boot lives in `backend/api/pom.xml`).
    if (hasMavenArtifact(ctx, /spring-boot/)) return true;
    // Fallback: scan first 10 Java files for `springframework` import.
    // Useful for test fixtures with neither pom.xml nor build.gradle.
    const javaFiles = ctx.files.filter((f) => f.endsWith('.java')).slice(0, 10);
    return javaFiles.some((f) => {
      try {
        const content = fs.readFileSync(path.join(ctx.rootDir, f), 'utf-8');
        return content.includes('springframework');
      } catch { return false; }
    });
  }

  readonly visitor: JavaFrameworkVisitor = createSpringVisitor();
}
