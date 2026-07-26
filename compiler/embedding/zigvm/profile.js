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
