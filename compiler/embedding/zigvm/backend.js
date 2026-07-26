import { buildDescriptor } from './descriptor.js';

const bytes = blob => Array.from(blob, x => `0x${x.toString(16).padStart(2, '0')}u`).join(', ');
const idBytes = (blob, at, len) => bytes(blob.slice(at, at + len));
const argument = (type, index) => type === 'number' ? `porf_box_num(zvm_porf_bits_f64(args[${index}].payload))` : type === 'f64' ? `zvm_porf_bits_f64(args[${index}].payload)` : `(i32)args[${index}].payload`;

export const appendEnjinModule = (c, cg) => {
  // Native helper functions remain internal implementation detail. The only
  // product ABI entry points appended below are query and numeric call.
  c = c.replace(/\n(?!(?:static ))(jsval|i32|u32|f64|void) (p\d+_[A-Za-z0-9_]+)\(/g, '\nstatic $1 $2(');
  const { blob, exports } = buildDescriptor(cg);
  const cases = exports.map(item => {
    const mismatch = item.params.map((type, i) => `!zvm_porf_value_is(args + ${i}u, ${type === 'i32' ? 'ZVM_VALUE_V2_I32' : 'ZVM_VALUE_V2_F64'})`).join(' || ') || '0';
    const callArgs = [ 'exec', 'provider', '&status' ];
    let user = 0;
    for (const param of item.f.params) {
      if (param.name === '#env') callArgs.push('0');
      else if (param.name[0] === '#') callArgs.push('JV_UNDEFINED');
      else { callArgs.push(argument(item.params[user], user)); user++; }
    }
    const call = `p${item.f.index}_${String(item.f.name).replace(/[^a-zA-Z0-9_]/g, '_')}(${callArgs.join(', ')})`;
    const write = item.result === 'void' ? `${call}; result->tag = ZVM_VALUE_V2_UNDEFINED; result->aux = 0u; result->payload = 0u;` : (item.result === 'f64' || item.result === 'number') ? `result->tag = ZVM_VALUE_V2_F64; result->aux = 0u; result->payload = zvm_porf_f64_bits(${item.result === 'number' ? `(${call}).val` : call});` : `result->tag = ZVM_VALUE_V2_I32; result->aux = 0u; result->payload = (u64)(i64)${call};`;
    return `case ${item.id}u: if (arg_count != ${item.params.length}u || ${mismatch}) return ZVM_STATUS_V2_SIGNATURE_MISMATCH; ${write} if (!zvm_porf_value_is(result, ${item.result === 'void' ? 'ZVM_VALUE_V2_UNDEFINED' : item.result === 'i32' ? 'ZVM_VALUE_V2_I32' : 'ZVM_VALUE_V2_F64'})) return ZVM_STATUS_V2_INTERNAL; break;`;
  }).join('\n    ');
  return `${c}

/* PORF-MOD-005: host-owned descriptor query and numeric v2 dispatch. */
static const unsigned char zvm_porf_descriptor_v2[] = { ${bytes(blob)} };
static const unsigned char zvm_porf_provider_id_v2[16] = { ${idBytes(blob, 104, 16)} };
static const unsigned char zvm_porf_provider_digest_v2[32] = { ${idBytes(blob, 120, 32)} };
static const uint64_t zvm_porf_provider_features_v2 = ${Array.from(blob.slice(152, 160)).reduce((n, x, i) => n + (BigInt(x) << BigInt(i * 8)), 0n)}ull;
static int zvm_porf_value_is(const zvm_value_v2* value, uint32_t tag) {
  if (value == NULL || value->tag != tag || value->aux != 0u) return 0;
  if (tag == ZVM_VALUE_V2_UNDEFINED) return value->payload == 0u;
  if (tag == ZVM_VALUE_V2_I32) return value->payload == (uint64_t)(int64_t)(int32_t)value->payload;
  return tag == ZVM_VALUE_V2_F64;
}
static const zvm_porf_provider_api_v1* zvm_porf_provider_for_exec_v2(zvm_porf_exec_ctx_v2* exec, uint32_t instance) {
  const zvm_porf_exec_boundary_v2* boundary = (const zvm_porf_exec_boundary_v2*)(const void*)exec;
  if (boundary == NULL || boundary->magic != ZVM_PORF_EXEC_BOUNDARY_V2_MAGIC || boundary->struct_size != sizeof(*boundary) || boundary->active != 1u || boundary->logical_instance_token != instance) return NULL;
  if (boundary->provider == NULL || boundary->provider->struct_size < sizeof(zvm_porf_provider_api_v1) || boundary->provider->abi_version != ZVM_PORFFOR_PROVIDER_API_V1_VERSION) return NULL;
  if (memcmp(boundary->provider_id.bytes, zvm_porf_provider_id_v2, sizeof zvm_porf_provider_id_v2) != 0 || memcmp(boundary->provider_abi_digest.bytes, zvm_porf_provider_digest_v2, sizeof zvm_porf_provider_digest_v2) != 0 || (zvm_porf_provider_features_v2 & ~boundary->provider_features) != 0u) return NULL;
  return boundary->provider;
}
zvm_status_v2 zvm_porf_module_query_v2(void* out, u32 capacity, u32* required) {
  if (required == NULL) return ZVM_STATUS_V2_INVALID_ARGUMENT;
  *required = (u32)sizeof zvm_porf_descriptor_v2;
  if (out == NULL) return capacity == 0u ? ZVM_STATUS_V2_OK : ZVM_STATUS_V2_INVALID_ARGUMENT;
  if (capacity < *required) return ZVM_STATUS_V2_INVALID_ARGUMENT;
  memcpy(out, zvm_porf_descriptor_v2, *required);
  return ZVM_STATUS_V2_OK;
}
zvm_status_v2 zvm_porf_call_v2(zvm_porf_exec_ctx_v2* exec, u32 export_id, u32 instance, const zvm_value_v2* args, u32 arg_count, zvm_value_v2* result) {
  if (exec == NULL || instance == 0u || result == NULL || (arg_count != 0u && args == NULL)) return ZVM_STATUS_V2_INVALID_ARGUMENT;
  const zvm_porf_provider_api_v1* provider = zvm_porf_provider_for_exec_v2(exec, instance);
  if (provider == NULL) return ZVM_STATUS_V2_PROVIDER_MISMATCH;
  zvm_status_v2 status = zvm_porf_poll(exec, provider, ZVM_PORF_SAFEPOINT_ENTRY);
  if (status != ZVM_STATUS_V2_OK) return status;
  switch (export_id) { ${cases} default: return ZVM_STATUS_V2_MISSING_EXPORT; }
  return status;
}
`;
};
