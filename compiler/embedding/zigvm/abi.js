// ZigVM embedded v2 C ABI helpers.
// PORF-MOD-004: status stays caller-owned and is never represented by TLS,
// longjmp, or a module-global runtime table.

export const isEmbeddedV2 = prefs => !!(prefs.zigvmEmbeddedV2 || prefs.enjinModule);

export const validateProfile = prefs => {
  if (!isEmbeddedV2(prefs)) return;
  if (prefs.zigvm) throw new Error('--zigvm-embedded-v2 cannot be combined with legacy --zigvm');
  if (prefs.gc !== false && prefs.gc != null) throw new Error('embedded v2 forbids GC');
  if (prefs.threads) throw new Error('embedded v2 forbids threads');
};

const cType = type => ({ i32: 'i32', f64: 'f64', void: 'void' })[type];

// Library calls are not normal Host capabilities.  The high-bit namespace is
// reserved for manifest ImportIds; the invocation-local Host router resolves
// that ID through the caller's active DispatchSnapshot and forwards the same
// exec/budget/status chain to ScriptLibrary.  No generated pointer survives a
// snapshot boundary.
export const libraryCall = (id, args, type) => {
  if (type !== 2 || args.length !== 1) throw new Error('embedded ScriptLibrary v1 lowering currently requires one i32 argument and i32 result');
  return `zvm_porf_library_i32(exec, provider, status, ${id}u, ${args[0]})`;
};

export const renderRuntime = ({ staticEnd, globals, hostImports }) => {
  const fields = globals.map(g => `  ${g.type === 1 ? 'f64' : g.type === 6 ? 'jsval' : 'u32'} ${g.name};`);
  const host = hostImports.map(imported => {
    const args = imported.parameters.map((type, index) => `${cType(type)} a${index}`).join(', ');
    const values = imported.parameters.map((type, index) =>
      type === 'f64'
        ? `(zvm_value_v2){ ZVM_VALUE_V2_F64, 0u, zvm_porf_f64_bits(a${index}) }`
        : `(zvm_value_v2){ ZVM_VALUE_V2_I32, 0u, (u64)(i64)a${index} }`);
    const result = imported.result === 'void' ? '' : 'zvm_value_v2 result = {0};\n  ';
    const call = `if (*status == ZVM_STATUS_V2_OK) *status = provider->host_dispatch(exec, ${imported.id}u, args, ${values.length}u, ${imported.result === 'void' ? 'NULL' : '&result'});`;
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
typedef uint16_t u16;
typedef int32_t i32;
typedef uint32_t u32;
typedef int64_t i64;
typedef uint64_t u64;
typedef double f64;
typedef struct jsval { f64 val; i32 type; } jsval;
typedef u64 jsbits;
#define JV_PATTERN 0xFFF8000000000000ull
#define JV_UNDEFINED ((jsval){0.0, 0})
#define JV_UNDEFINED_BITS (JV_PATTERN | ((u64)0u << 43))
#define JV_ZERO_BITS (JV_PATTERN | ((u64)1u << 43))
#define ZVM_PORF_SAFEPOINT_ENTRY 0x1u
#define ZVM_PORF_SAFEPOINT_BACKEDGE 0x2u
#define ZVM_PORF_SAFEPOINT_CALL 0x4u
static inline jsval porf_box_num(f64 value) { return (jsval){ value, 1 }; }
static inline jsval porf_box(f64 value, i32 type) { return (jsval){ value, type }; }
static inline u64 porf_f64_to_bits(f64 value) { u64 bits; memcpy(&bits, &value, sizeof bits); return bits; }
static inline f64 porf_bits_to_f64_bits(u64 bits) { f64 value; memcpy(&value, &bits, sizeof value); return value; }
static inline jsbits porf_pack(jsval value) {
  if (value.type == 1) {
    const jsbits bits = porf_f64_to_bits(value.val);
    return (bits & JV_PATTERN) == JV_PATTERN ? 0x7FF8000000000000ull : bits;
  }
  return JV_PATTERN | ((u64)(value.type & 0xff) << 43) | (u64)(u32)value.val;
}
static inline jsval porf_unpack(jsbits value) {
  if ((value & JV_PATTERN) != JV_PATTERN) return porf_box_num(porf_bits_to_f64_bits(value));
  return (jsval){ (f64)(u32)value, (i32)((value >> 43) & 0xff) };
}
static inline i32 porf_jv_type(jsval value) { return value.type; }
static inline i32 porf_jv_is_num(jsval value) { return value.type == 1; }
static inline i32 porf_jv_eq(jsval a, jsval b) { return a.type == b.type && (a.type == 1 ? a.val == b.val : (u32)a.val == (u32)b.val); }
static inline i32 porf_truthy(jsval value) { return value.type == 1 ? value.val == value.val && value.val != 0.0 : (u32)value.val != 0u; }
static inline i32 porf_falsy(jsval value) { return !porf_truthy(value); }
static inline i32 porf_nullish(jsval value) { return value.type == 0 || (value.type == 6 && (u32)value.val == 0u); }
static inline i32 porf_f64_to_i32(f64 value) { if (value != value) return 0; if (value <= -2147483648.0) return -2147483648; if (value >= 2147483647.0) return 2147483647; return (i32)value; }
static inline u32 porf_f64_to_u32(f64 value) { if (value != value || value <= 0.0) return 0u; if (value >= 4294967295.0) return 4294967295u; return (u32)value; }

/* PORF-MOD-003: mutable bytes, allocator cursor, and JS globals live in the
 * caller's exec arena. The only module-level data below is immutable C code. */
typedef struct zvm_porf_globals_v2 {
${fields.join('\n') || '  u8 unused;'}
} zvm_porf_globals_v2;

#define PORF_STATIC_END ${staticEnd}u
#define PORF_GLOBALS_END (PORF_STATIC_END + (u32)sizeof(zvm_porf_globals_v2))
#define PORF_ALLOCATOR_OFFSET ((PORF_GLOBALS_END + 7u) & ~7u)
#define PORF_CONTEXT_END (PORF_ALLOCATOR_OFFSET + (u32)sizeof(u32))
static inline u64 zvm_porf_f64_bits(f64 value) { union { f64 f; u64 u; } bits = { value }; return bits.u; }
static inline f64 zvm_porf_bits_f64(u64 value) { union { f64 f; u64 u; } bits = { .u = value }; return bits.f; }
static inline u8* zvm_porf_memory(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider) {
  return (u8*)provider->memory_base(exec);
}
static inline int zvm_porf_prepare(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2* status) {
  if (*status != ZVM_STATUS_V2_OK) return 0;
  /* Reserve and commit the complete mutable prefix before taking any arena
   * pointer. This keeps a short arena from becoming an unchecked dereference. */
  if (!provider->memory_reserve(exec, PORF_CONTEXT_END) || !provider->memory_commit(exec, PORF_CONTEXT_END) || zvm_porf_memory(exec, provider) == NULL) {
    *status = ZVM_STATUS_V2_INTERNAL;
    return 0;
  }
  return 1;
}
static inline zvm_porf_globals_v2* zvm_porf_globals(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider) {
  return (zvm_porf_globals_v2*)(zvm_porf_memory(exec, provider) + PORF_STATIC_END);
}
static inline u32 zvm_porf_alloc(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2* status, u32 bytes, u32 type_id) {
  if (!zvm_porf_prepare(exec, provider, status)) return 0u;
  if (bytes > UINT32_MAX - 7u) {
    *status = ZVM_STATUS_V2_INTERNAL;
    return 0u;
  }
  u8* memory = zvm_porf_memory(exec, provider);
  u32* cursor = (u32*)(memory + PORF_ALLOCATOR_OFFSET);
  const u32 start = (*cursor == 0u ? (PORF_CONTEXT_END + 7u) & ~7u : *cursor);
  const u32 end = start + ((bytes + 7u) & ~7u);
  (void)type_id;
  if (end < start || !provider->memory_reserve(exec, end) || !provider->memory_commit(exec, end)) {
    *status = ZVM_STATUS_V2_INTERNAL;
    return 0u;
  }
  *cursor = end;
  return start;
}
static inline zvm_status_v2 zvm_porf_poll(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, u32 flags) {
  return provider->safepoint_poll(exec, flags);
}
static inline zvm_status_v2 zvm_porf_raise_trap(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, u32 code) {
  return provider->raise_trap(exec, code);
}
static inline i32 zvm_porf_library_i32(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2* status, u32 import_id, i32 value) {
  zvm_value_v2 args[1] = { { ZVM_VALUE_V2_I32, 0u, (u64)(i64)value } };
  zvm_value_v2 result = {0};
  if (*status == ZVM_STATUS_V2_OK) *status = provider->host_dispatch(exec, 0x80000000u | import_id, args, 1u, &result);
  if (*status != ZVM_STATUS_V2_OK || result.tag != ZVM_VALUE_V2_I32 || result.aux != 0u) return 0;
  return (i32)result.payload;
}
${host}
`;
};

// Raw C in a retained Porffor builtin was written for the ordinary `MEM`
// macro. Every retained v2 function has explicit exec/provider parameters, so
// rewrite that spelling before scanning instead of allowing an implicit arena.
export const rewriteGeneratedC = c => c.replace(/\bMEM\b/g, 'zvm_porf_memory(exec, provider)');

export const scanGeneratedC = c => {
  const forbidden = [
    /\bporf_mem\b/, /\bzvm_porf_runtime_api_storage\b/, /\bzvm_porf_host_api_storage\b/,
    /\bporf_heap_(?:base|cur|committed|top)\b/, /\bzvm_porf_initialized\b/, /\bMEM\b/
  ];
  for (const pattern of forbidden) {
    if (pattern.test(c)) throw new Error(`embedded v2 generated forbidden mutable singleton: ${pattern}`);
  }
  return c;
};
