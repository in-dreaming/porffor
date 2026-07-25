// PORF-MOD-003/004 renderer adapter. Core render.js asks this module for the
// v2-only spellings, keeping ordinary C and legacy --zigvm text unchanged.
import { renderRuntime, rewriteGeneratedC, scanGeneratedC } from './abi.js';

export const createAdapter = ({ enabled, staticEnd, globals, hostImports }) => {
  if (!enabled) return null;
  return {
    prelude: () => renderRuntime({ staticEnd, globals, hostImports }),
    functionParams: params => `zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2* status${params ? ', ' + params : ''}`,
    functionArgs: args => `exec, provider, status${args ? ', ' + args : ''}`,
    memory: () => 'zvm_porf_memory(exec, provider)',
    alloc: (bytes, type) => `zvm_porf_alloc(exec, provider, status, ${bytes}, ${type})`,
    poll: (flags, defaultValue) => `if (*status == ZVM_STATUS_V2_OK && (*status = zvm_porf_poll(exec, provider, ${flags})) != ZVM_STATUS_V2_OK) return ${defaultValue}; if (*status != ZVM_STATUS_V2_OK) return ${defaultValue};`,
    // Call nodes render as C expressions, so use a conditional expression to
    // keep the poll immediately before the callee while preventing it from
    // running after cancellation, budget exhaustion, or a prior trap. The
    // enclosing statement's status guard returns from the generated function.
    callSafepoint: (call, type) => {
      const fallback = type === 6 ? 'JV_UNDEFINED'
        : type === 1 ? '0.0'
          : type === 4 ? '0ll'
            : type === 5 ? '0ull'
              : type === 0 ? '(void)0'
                : '0';
      return `((*status == ZVM_STATUS_V2_OK && (*status = zvm_porf_poll(exec, provider, ZVM_PORF_SAFEPOINT_CALL)) == ZVM_STATUS_V2_OK) ? (${call}) : ${fallback})`;
    },
    hostCall: (name, args) => `zvm_porf_host_${name}(exec, provider, status${args ? ', ' + args : ''})`,
    global: name => `zvm_porf_globals(exec, provider)->${name}`,
    prepare: defaultValue => `if (!zvm_porf_prepare(exec, provider, status)) return ${defaultValue};`,
    statusGuard: defaultValue => `if (*status != ZVM_STATUS_V2_OK) return ${defaultValue};`,
    trap: (code, defaultValue) => `if (*status == ZVM_STATUS_V2_OK) *status = zvm_porf_raise_trap(exec, provider, ${code}); return ${defaultValue};`,
    finish: c => scanGeneratedC(rewriteGeneratedC(c))
  };
};
