export class GameplayProfileDiagnostic extends Error {
  constructor(code, detail, source = globalThis.file ?? '<input>', span = null) {
    super(`${code}: ${detail}`);
    this.name = 'GameplayProfileDiagnostic';
    this.code = code;
    this.phase = 'gameplay_profile';
    this.module_id = globalThis.Prefs?.enjinModuleId ?? null;
    this.source = source;
    this.span = span;
    this.detail = detail;
  }
}

export const profileFailure = (code, detail, node) => {
  const span = node?.loc ? { line: node.loc.start.line, column: node.loc.start.column } : null;
  throw new GameplayProfileDiagnostic(code, detail, globalThis.file ?? '<input>', span);
};
