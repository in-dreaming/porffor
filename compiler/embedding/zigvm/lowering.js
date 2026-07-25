// Explicit-exec lowering for the ZigVM embedded v2 profile.
//
// PORF-MOD-002: keep propagation out of the upstream IR constructors. The
// renderer consumes the metadata; ordinary and legacy ZigVM IR are untouched.
import { K, FX, N_A, N_B, N_C, N_FX } from '../../ir.js';

const statefulKinds = new Set([
  K.Load, K.Store, K.MemCopy, K.MemFill, K.Alloc,
  K.HostCall, K.Throw, K.ThrowNew
]);

const visit = (node, directCalls) => {
  if (!Array.isArray(node)) return false;
  if (typeof node[0] !== 'number' || node.length !== 6) {
    let effect = false;
    for (const child of node) effect ||= visit(child, directCalls);
    return effect;
  }

  if (node[0] === K.CallDynamic) throw new Error('embedded v2 does not support dynamic calls');
  if (node[0] === K.Call && typeof node[N_A] === 'number') directCalls.add(node[N_A]);
  let effect = statefulKinds.has(node[0]) || (node[N_FX] & (FX.readMem | FX.writeMem | FX.call)) !== 0;
  effect ||= visit(node[N_A], directCalls);
  effect ||= visit(node[N_B], directCalls);
  effect ||= visit(node[N_C], directCalls);
  return effect;
};

// The profile passes exec/provider/status through every generated function.
// Marking every retained function avoids an implicit boundary through a
// tree-shaken helper or an indirect call; `stateful` remains useful evidence
// for diagnostics and future specialization.
export const lowerExplicitExec = cg => {
  const functions = cg.funcs.filter(Boolean);
  const byIndex = new Map(functions.map(f => [f.index, f]));
  const metadata = new Map();

  for (const f of functions) {
    const calls = new Set();
    metadata.set(f.index, { calls, stateful: visit(f.body, calls) });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [index, info] of metadata) {
      for (const callee of info.calls) {
        if (metadata.get(callee)?.stateful && !info.stateful) {
          info.stateful = true;
          changed = true;
        }
      }
      if (!byIndex.has(index)) throw new Error(`embedded v2 call references missing function ${index}`);
    }
  }

  for (const f of functions) {
    const info = metadata.get(f.index);
    f.zigvmExplicitExec = true;
    f.zigvmStateful = info.stateful;
  }
  cg.zigvmExplicitExec = true;
  return cg;
};
