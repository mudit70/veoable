import type { FrameworkPlugin, ProjectContext } from '@veoable/plugin-api';
import { hasCargoCrate } from '@veoable/plugin-api';
import type { RustFrameworkVisitor } from '@veoable/lang-rust';
import { createRustcliVisitor } from './visitor.js';

/**
 * Rust CLI framework plugin (#62).
 *
 * Detects client-side processes in Rust CLI/desktop applications:
 *   - #[tauri::command] attributes → bridge_command
 *   - main() fn entry points → script_entry
 *   - Clap #[derive(Parser/Subcommand)] → cli_command (via main match arms)
 *
 * Activates when Cargo.toml contains clap or tauri.
 */
export const RUSTCLI_PLUGIN_ID = 'rustcli' as const;

export class RustcliPlugin implements FrameworkPlugin {
  readonly id = RUSTCLI_PLUGIN_ID;
  readonly language = 'rust';

  appliesTo(ctx: ProjectContext): boolean {
    if (!ctx.files.some((f) => f.endsWith('.rs'))) return false;
    return hasCargoCrate(ctx, 'clap') || hasCargoCrate(ctx, 'tauri');
  }

  readonly visitor: RustFrameworkVisitor = createRustcliVisitor();
}
