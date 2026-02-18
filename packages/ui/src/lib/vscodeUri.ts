/**
 * Convert a filesystem path to a vscode://file/ URI.
 * Handles Windows backslash-to-forward-slash conversion.
 * Reuses an existing VS Code window if the folder is already open.
 */
export function toVSCodeUri(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  return `vscode://file/${normalized}`;
}
