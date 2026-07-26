import { profileFailure } from './diagnostics.js';

// This intentionally runs on the parser AST, before code generation or C rendering.
export const checkGameplayProfile = program => {
  // This is intentionally closed rather than alias-aware. A gameplay module
  // has no legitimate use for eval/globalThis, and its only permitted FFI
  // spelling is the compiler-recognized direct HostCall declaration below.
  // Rejecting the source references themselves prevents indirect calls,
  // aliases, and computed properties from becoming alternate escape hatches.
  const canonicalHostCall = node => node?.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' && !node.callee.computed &&
    node.callee.object?.type === 'Identifier' && node.callee.object.name === 'Porffor' &&
    node.callee.property?.type === 'Identifier' && node.callee.property.name === 'dlopen' &&
    node.arguments?.[0]?.type === 'Literal' &&
    (node.arguments[0].value === '__zigvm_host__' || node.arguments[0].value === '__zigvm_library__');
  // An exported ScriptLibrary is shared by every gameplay module using it.
  // A `const` only freezes the binding: object, array, and constructed values
  // would still create shared mutable module storage. Keep the accepted
  // top-level initializers deliberately narrow and immutable.
  const mutableGlobalValue = node => {
    if (!node) return false;
    // This declaration is lowered to an invocation-local provider binding;
    // it does not allocate module-global library state.
    if (canonicalHostCall(node)) return false;
    if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression' || node.type === 'NewExpression' || node.regex != null) return true;
    if (node.type === 'CallExpression' || node.type === 'AwaitExpression') return true;
    if (node.type === 'TSAsExpression' || node.type === 'TypeCastExpression') return mutableGlobalValue(node.expression);
    return false;
  };
  const visit = (node, topLevel = false) => {
    if (!node || typeof node !== 'object') return;
    if (canonicalHostCall(node)) {
      // Do not visit the allowed callee. Its arguments still need normal
      // profile checks (for example, an eval expression is never allowed).
      for (const argument of node.arguments) visit(argument, false);
      return;
    }
    if (node.type === 'ExportNamedDeclaration' && node.declaration) visit(node.declaration, true);
    if (node.type === 'VariableDeclaration' && topLevel && node.kind !== 'const') profileFailure('ZVM-PROFILE-001', 'mutable module global', node);
    if (node.type === 'VariableDeclaration' && topLevel && node.kind === 'const' && node.declarations.some(item => mutableGlobalValue(item.init))) profileFailure('ZVM-PROFILE-001', 'mutable reference-valued module global', node);
    if (node.type === 'ImportExpression') profileFailure('ZVM-PROFILE-002', 'dynamic import', node);
    if (node.type === 'AwaitExpression' || node.type === 'YieldExpression' || node.type === 'TryStatement') profileFailure('ZVM-PROFILE-003', 'async or unwind construct', node);
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.async) profileFailure('ZVM-PROFILE-003', 'async function', node);
    if (node.type === 'Identifier' && (node.name === 'eval' || node.name === 'globalThis')) profileFailure('ZVM-PROFILE-004', 'eval or globalThis is not allowed in gameplay modules', node);
    if (node.type === 'Identifier' && node.name === 'Porffor') profileFailure('ZVM-PROFILE-005', 'FFI is not allowed in gameplay modules', node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'loc') continue;
      if (Array.isArray(value)) for (const item of value) visit(item, node.type === 'Program');
      else if (value && typeof value === 'object' && value.type) visit(value, false);
    }
  };
  visit(program, false);
};
