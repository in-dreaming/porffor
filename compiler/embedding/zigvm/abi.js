// ZigVM embedded v2 C ABI helpers.
// PORF-MOD-004: status stays caller-owned and is never represented by TLS,
// longjmp, or a module-global runtime table.

export const isEmbeddedV2 = prefs => !!prefs.zigvmEmbeddedV2;

export const validateProfile = prefs => {
  if (!isEmbeddedV2(prefs)) return;
  if (prefs.zigvm) throw new Error('--zigvm-embedded-v2 cannot be combined with legacy --zigvm');
  if (prefs.gc !== false && prefs.gc != null) throw new Error('embedded v2 forbids GC');
  if (prefs.threads) throw new Error('embedded v2 forbids threads');
};

const cType = type => ({ i32: 'i32', f64: 'f64', void: 'void' })[type];

export const renderRuntime = ({ staticEnd, globals, hostImports }) => {
  const fields = globals.map(g => `  ${g.type === 1 ? 'f64' : g.type === 6 ? 'jsval' : 'u32'} ${g.name};`);
  const host = hostImports.map(imported => {
    const args = imported.parameters.map((type, index) => `${cType(type)} a${index}`).join(', ');
    const values = imported.parameters.map((type, index) =>
      type === 'f64'
        ? `(zvm_value_v2){ ZVM_VALUE_V2_F64, 0u, zvm_porf_f64_bits(a${index}) }`
        : `(zvm_value_v2){ ZVM_VALUE_V2_I32, 0u, (u64)(i64)a${index} }`);
    const result = imported.result === 'void' ? '' : 'zvm_value_v2 result = {0};\n  ';
    const call = `*status = provider->host_dispatch(exec, ${imported.id}u, args, ${values.length}u, ${imported.result === 'void' ? 'NULL' : '&result'});`;
    const fail = imported.result === 'f64' ? '0.0' : imported.result === 'void' ? '' : '0';
    const returned = imported.result === 'f64'
      ? 'return zvm_porf_bits_f64(result.payload);'
      : imported.result === 'i32' ? 'return (i32)result.payload;'
      : 'return;';
    return `static ${cType(imported.result)} zvm_porf_host_${imported.name}(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2* status${args ? ', ' + args : ''}) {
  zvm_value_v2 args[${Math.max(values.length, 1)}] = { ${values.join(', ') || '{0}'} };
  ${result}${call}
  if (*status != ZVM_STATUS_V2_OK) ${imported.result === 'void' ? 'return;' : `return ${fail};`}
  ${returned}
}`;
  }).join('\n\n');

  return `#include <zigvm/porffor_embedded_v2.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>

typedef uint8_t u8;
typedef int32_t i32;
typedef uint32_t u32;
typedef int64_t i64;
typedef uint64_t u64;
typedef double f64;
typedef struct jsval { f64 val; i32 type; } jsval;
typedef u64 jsbits;
#define JV_UNDEFINED ((jsval){0.0, 1})
static inline jsval porf_box_num(f64 value) { return (jsval){ value, 0 }; }
static inline jsval porf_box(f64 value, i32 type) { return (jsval){ value, type }; }
static inline jsbits porf_pack(jsval value) { (void)value; return 0; }
static inline jsval porf_unpack(jsbits value) { (void)value; return JV_UNDEFINED; }
static inline i32 porf_jv_type(jsval value) { return value.type; }
static inline i32 porf_truthy(jsval value) { return value.type == 0 ? value.val != 0.0 : value.type != 1; }

/* PORF-MOD-003: mutable bytes, allocator cursor, and JS globals live in the
 * caller's exec arena. The only module-level data below is immutable C code. */
typedef struct zvm_porf_globals_v2 {
${fields.join('\n') || '  u8 unused;'}
} zvm_porf_globals_v2;

#define PORF_STATIC_END ${staticEnd}u
#define PORF_GLOBALS_END (PORF_STATIC_END + (u32)sizeof(zvm_porf_globals_v2))
static inline u64 zvm_porf_f64_bits(f64 value) { union { f64 f; u64 u; } bits = { value }; return bits.u; }
static inline f64 zvm_porf_bits_f64(u64 value) { union { f64 f; u64 u; } bits = { .u = value }; return bits.f; }
static inline u8* zvm_porf_memory(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider) {
  return (u8*)provider->memory_base(exec);
}
static inline zvm_porf_globals_v2* zvm_porf_globals(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider) {
  const u32 end = PORF_GLOBALS_END;
  if (!provider->memory_reserve(exec, end) || !provider->memory_commit(exec, end)) return NULL;
  return (zvm_porf_globals_v2*)(zvm_porf_memory(exec, provider) + PORF_STATIC_END);
}
static inline u32 zvm_porf_alloc(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, u32 bytes, u32 type_id) {
  u8* memory = zvm_porf_memory(exec, provider);
  u32* cursor = (u32*)(memory + PORF_GLOBALS_END);
  const u32 start = (*cursor == 0u ? (PORF_GLOBALS_END + 15u) & ~7u : *cursor);
  const u32 end = start + ((bytes + 7u) & ~7u);
  (void)type_id;
  if (end < start || !provider->memory_reserve(exec, end) || !provider->memory_commit(exec, end)) return 0u;
  *cursor = end;
  return start;
}
static inline zvm_status_v2 zvm_porf_poll(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, u32 flags) {
  return provider->safepoint_poll(exec, flags);
}
${host}
`;
};

export const scanGeneratedC = c => {
  const forbidden = [
    /\bporf_mem\b/, /\bzvm_porf_runtime_api_storage\b/, /\bzvm_porf_host_api_storage\b/,
    /\bporf_heap_(?:base|cur|committed|top)\b/, /\bzvm_porf_initialized\b/
  ];
  for (const pattern of forbidden) {
    if (pattern.test(c)) throw new Error(`embedded v2 generated forbidden mutable singleton: ${pattern}`);
  }
  return c;
};
