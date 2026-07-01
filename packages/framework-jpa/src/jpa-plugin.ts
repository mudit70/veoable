import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasMavenArtifact } from '@veoable/plugin-api';
import type { JavaFrameworkVisitor } from '@veoable/lang-java';
import { createJpaVisitor } from './visitor.js';

/**
 * JPA/Hibernate framework plugin (#51).
 *
 * Detects database interactions via Spring Data JPA repository method calls:
 *   repository.findAll(), repository.findById(), repository.save(),
 *   repository.deleteById(), repository.findByEmail(), etc.
 *
 * Activates when pom.xml/build.gradle contains spring-data-jpa or hibernate.
 */
export const JPA_PLUGIN_ID = 'jpa' as const;

export class JpaPlugin implements FrameworkPlugin {
  readonly id = JPA_PLUGIN_ID;
  readonly language = 'java';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.java'))) return false;
    return hasMavenArtifact(ctx, /spring-boot-starter-data-jpa/) || hasMavenArtifact(ctx, /hibernate/);
  }

  readonly visitor: JavaFrameworkVisitor = createJpaVisitor();
}
