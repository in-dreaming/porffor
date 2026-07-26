// PORF-MOD-007: closed, content-authenticated canonical build input bridge.
import fs from 'node:fs';
const HEX = bytes => new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i');
// The in-tree adapter implements one BLAKE3 chunk. Keep this exactly aligned
// with Zig's `max_content_bytes` until it grows a tree/streaming implementation.
export const MAX_CONTENT = 1024;
export const MAX_REGISTRY = 4096;
const REQUIRED = new Set(['schema_version','module_id','canonical_manifest_digest','state_schema_digest','source_graph_digest','profile','target','cpu','options_digest','artifact_version','abi_version','bundle_utf8','bundle_digest','source_map_utf8','source_map_digest','provider','node_fingerprint','typescript_fingerprint','c_fingerprint','zig_fingerprint','host_api_digest','toolchain_digest','porffor_gitlink','backend_schema','modification_revision','public_interface_digest','descriptor','sources','export_registry','import_registry','field_ids','dependencies','codegen_options']);
export class BuildDiagnostic extends Error {
  constructor(code, detail, context = {}) { super(`${code}: ${detail}`); this.name = 'BuildDiagnostic'; this.code = code; this.phase = 'build_input'; this.module_id = context.module_id ?? null; this.version_id = context.version_id ?? null; this.transaction_id = context.transaction_id ?? null; this.detail = detail; }
  renderHuman() { return `${this.code} phase=${this.phase} module_id=${this.module_id ?? '-'} version_id=${this.version_id ?? '-'} transaction_id=${this.transaction_id ?? '-'}: ${this.detail}`; }
}
const fail = (code, detail) => { throw new BuildDiagnostic(code, detail); };
const provenancePath = new URL('../../../../../src/compiler/script_module/build_provenance.json', import.meta.url);
const provenance = () => {
  try {
    const value = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    return { porffor_gitlink: value.porffor_gitlink, modification_revision: value.modification_revision };
  } catch { fail('ZVM-BUILD-011', 'parent-owned build provenance is missing or malformed'); }
};
const hex = (v, n, name) => { if (typeof v !== 'string' || !HEX(n).test(v) || /^0+$/.test(v)) fail('ZVM-BUILD-003', `${name} must be a nonzero ${n * 2}-digit digest`); return v.toLowerCase(); };
const u32 = (v, name) => { if (!Number.isInteger(v) || v <= 0 || v > 0xffffffff) fail('ZVM-BUILD-004', `${name} must be a nonzero u32`); return v; };
const u32zero = (v, name) => { if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) fail('ZVM-BUILD-004', `${name} must be a u32`); return v; };
const text = (v, name, empty = false) => { if (typeof v !== 'string' || (!empty && !v) || Buffer.byteLength(v) > MAX_CONTENT || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v)) fail('ZVM-BUILD-002', `${name} must be UTF-8 without unpaired surrogates within limits`); return v; };
const path = v => { text(v, 'source logical_path'); if (/^[A-Za-z]:|^\\\\|^\//.test(v) || v.includes('\\') || v.split('/').some(x => !x || x === '.' || x === '..')) fail('ZVM-BUILD-005', 'source logical_path must be a relative logical path'); return v; };
const rot = (x, n) => (x >>> n) | (x << (32 - n));
const IV = [0x6A09E667,0xBB67AE85,0x3C6EF372,0xA54FF53A,0x510E527F,0x9B05688C,0x1F83D9AB,0x5BE0CD19];
const PERM = [2,6,3,10,7,0,4,13,1,11,12,5,9,14,15,8];
const words = bytes => Array.from({length:16}, (_, i) => (bytes[i*4] ?? 0) | ((bytes[i*4+1] ?? 0) << 8) | ((bytes[i*4+2] ?? 0) << 16) | ((bytes[i*4+3] ?? 0) << 24));
const compress = (cv, m, len, flags) => { const s = [...cv, ...IV.slice(0,4), 0, 0, len, flags]; let msg = m; const g = (a,b,c,d,x,y) => { s[a]=(s[a]+s[b]+x)>>>0; s[d]=rot(s[d]^s[a],16); s[c]=(s[c]+s[d])>>>0; s[b]=rot(s[b]^s[c],12); s[a]=(s[a]+s[b]+y)>>>0; s[d]=rot(s[d]^s[a],8); s[c]=(s[c]+s[d])>>>0; s[b]=rot(s[b]^s[c],7); }; for(let r=0;r<7;r++){ g(0,4,8,12,msg[0],msg[1]);g(1,5,9,13,msg[2],msg[3]);g(2,6,10,14,msg[4],msg[5]);g(3,7,11,15,msg[6],msg[7]);g(0,5,10,15,msg[8],msg[9]);g(1,6,11,12,msg[10],msg[11]);g(2,7,8,13,msg[12],msg[13]);g(3,4,9,14,msg[14],msg[15]); msg=PERM.map(i=>msg[i]); } return s.slice(0,8).map((x,i)=>(x^s[i+8])>>>0); };
// Canonical input content is deliberately bounded to one BLAKE3 chunk.
export const canonicalBlake3 = value => { const b = Buffer.from(value, 'utf8'); if (!b.length || b.length > MAX_CONTENT) fail('ZVM-BUILD-007', 'content is empty or exceeds the canonical input limit'); let cv = IV, output; for(let off=0;off<b.length;off+=64){ const last=off+64>=b.length; output=compress(cv,words(b.subarray(off,off+64)),Math.min(64,b.length-off),(off===0?1:0)|(last?2:0)|(last?8:0)); if(!last) cv=output; } return Buffer.concat(output.map(x=>Buffer.from([x&255,(x>>>8)&255,(x>>>16)&255,x>>>24]))).toString('hex'); };
const ids = (xs, name) => { if (!Array.isArray(xs) || xs.length > MAX_REGISTRY) fail('ZVM-BUILD-002', `${name} must be a bounded array`); const r=xs.map(x=>u32(x,name)).sort((a,b)=>a-b); if(r.some((x,i)=>i&&x===r[i-1])) fail('ZVM-BUILD-006', `duplicate ${name}`); return r; };
const closed = (o, allowed, name) => { if (!o || typeof o !== 'object' || Array.isArray(o)) fail('ZVM-BUILD-002', `${name} must be an object`); for(const k of Object.keys(o)) if(!allowed.has(k)) fail('ZVM-BUILD-002', `${name}.${k} is unknown`); };
const optionIds = (v, name) => ids(v, `codegen_options.${name}`);
const options = raw => {
  const allowed = new Set(['module','typescript','gc','optimize']);
  closed(raw, allowed, 'codegen_options');
  const r = {};
  for (const name of ['module','typescript','gc','optimize']) if (name in raw) {
    if (typeof raw[name] !== 'boolean') fail('ZVM-BUILD-002', `codegen_options.${name} must be boolean`);
    r[name] = raw[name];
  }
  for (const name of ['module','typescript','gc','optimize']) if (!(name in r)) fail('ZVM-BUILD-002', `codegen_options.${name} is required`);
  return r;
};
export const parseCanonicalModuleInput = raw => {
  if (raw?.cancelled || raw?.signal?.aborted) fail('ZVM-BUILD-012', 'canonical build cancelled');
  let x; try { x=typeof raw==='string'?JSON.parse(raw):raw; } catch { fail('ZVM-BUILD-001','invalid JSON'); }
  closed(x, REQUIRED, 'manifest'); for(const k of REQUIRED) if(!(k in x)) fail('ZVM-BUILD-002', `manifest.${k} is required`); if(x.schema_version!==1) fail('ZVM-BUILD-001','unsupported schema_version');
  if (!Array.isArray(x.sources) || x.sources.length > MAX_REGISTRY) fail('ZVM-BUILD-002', 'sources must be a bounded array');
  const sources = x.sources.map(s => { closed(s,new Set(['logical_path','utf8','digest']),'source'); const logical_path=path(s.logical_path), utf8=text(s.utf8,'source utf8'), digest=hex(s.digest,32,'source.digest'); if(canonicalBlake3(utf8)!==digest) fail('ZVM-BUILD-008','source digest mismatch'); return {logical_path,utf8,digest}; }).sort((a,b)=>a.logical_path < b.logical_path ? -1 : a.logical_path > b.logical_path ? 1 : 0);
  if(!sources.length || sources.some((s,i)=>i&&s.logical_path===sources[i-1].logical_path)) fail('ZVM-BUILD-006','invalid source registry');
  closed(x.provider,new Set(['id','abi_digest','required_features']),'provider');
  if (!Array.isArray(x.dependencies) || x.dependencies.length > MAX_REGISTRY) fail('ZVM-BUILD-002', 'dependencies must be a bounded array');
  const deps=x.dependencies.map(d=>{closed(d,new Set(['module_id','public_interface_digest']),'dependency');return {module_id:hex(d.module_id,16,'dependency.module_id'),public_interface_digest:hex(d.public_interface_digest,32,'dependency.public_interface_digest')};}).sort((a,b)=>a.module_id < b.module_id ? -1 : a.module_id > b.module_id ? 1 : 0);
  if(deps.some((d,i)=>i&&d.module_id===deps[i-1].module_id)) fail('ZVM-BUILD-006','duplicate dependency ModuleId');
  const bundle_utf8=text(x.bundle_utf8,'bundle_utf8'), source_map_utf8=text(x.source_map_utf8,'source_map_utf8'); try { const m=JSON.parse(source_map_utf8); if(!m || typeof m!=='object' || m.version !== 3 || !Array.isArray(m.sources) || !m.sources.length || m.sources.length > MAX_REGISTRY || !Array.isArray(m.names) || m.names.length > MAX_REGISTRY || typeof m.mappings !== 'string' || !/^[A-Za-z0-9+/;,]*$/.test(m.mappings) || m.sources.some(s=>{ try { path(s); return false; } catch { return true; } })) fail('ZVM-BUILD-009','source map is malformed'); } catch(e) { if(e.code) throw e; fail('ZVM-BUILD-009','source map is malformed'); }
  const codegen_options = options(x.codegen_options);
  if (codegen_options.gc) fail('ZVM-BUILD-002', 'codegen_options.gc=true is unsupported by embedded-v2');
  const registry = (xs, name, value) => {
    if (!Array.isArray(xs) || xs.length > MAX_REGISTRY) fail('ZVM-BUILD-002', `${name} must be a bounded array`);
    const seenNames = new Set(), seenIds = new Set();
    const out = xs.map(item => { closed(item, new Set(['name','id', ...(value ? [value] : [])]), name); const entry = { name:text(item.name, `${name}.name`), id:u32(item.id, `${name}.id`) }; if (value) entry[value] = u32(item[value], `${name}.${value}`); if (seenNames.has(entry.name) || seenIds.has(entry.id)) fail('ZVM-BUILD-006', `duplicate ${name}`); seenNames.add(entry.name); seenIds.add(entry.id); return entry; });
    return out.sort((a,b)=>a.id-b.id);
  };
  const export_registry = registry(x.export_registry, 'export_registry');
  const import_registry = registry(x.import_registry, 'import_registry', 'signature_index');
  const descriptorAllowed = new Set(['required_features','scratch_min','scratch_max','scratch_alignment','flags','capability_registry']);
  closed(x.descriptor, descriptorAllowed, 'descriptor');
  const descriptor = { required_features: Number.isSafeInteger(x.descriptor.required_features) && x.descriptor.required_features >= 0 ? x.descriptor.required_features : fail('ZVM-BUILD-004','descriptor.required_features must be a u64'), scratch_min:u32zero(x.descriptor.scratch_min,'descriptor.scratch_min'), scratch_max:u32zero(x.descriptor.scratch_max,'descriptor.scratch_max'), scratch_alignment:u32(x.descriptor.scratch_alignment,'descriptor.scratch_alignment'), flags:u32zero(x.descriptor.flags,'descriptor.flags'), capability_registry: registry(x.descriptor.capability_registry, 'descriptor.capability_registry', 'host_function_id') };
  if (descriptor.scratch_min > descriptor.scratch_max || descriptor.scratch_alignment === 0 || (descriptor.scratch_alignment & (descriptor.scratch_alignment - 1))) fail('ZVM-BUILD-002','invalid descriptor scratch limits');
  const canonical={schema_version:1,module_id:hex(x.module_id,16,'module_id'),canonical_manifest_digest:hex(x.canonical_manifest_digest,32,'canonical_manifest_digest'),state_schema_digest:hex(x.state_schema_digest,32,'state_schema_digest'),source_graph_digest:hex(x.source_graph_digest,32,'source_graph_digest'),profile:text(x.profile,'profile'),target:text(x.target,'target'),cpu:text(x.cpu,'cpu'),options_digest:hex(x.options_digest,32,'options_digest'),artifact_version:u32(x.artifact_version,'artifact_version'),abi_version:u32(x.abi_version,'abi_version'),bundle_utf8,bundle_digest:hex(x.bundle_digest,32,'bundle_digest'),source_map_utf8,source_map_digest:hex(x.source_map_digest,32,'source_map_digest'),provider:{id:hex(x.provider.id,16,'provider.id'),abi_digest:hex(x.provider.abi_digest,32,'provider.required_features'),required_features:Number.isSafeInteger(x.provider.required_features)&&x.provider.required_features>=0?x.provider.required_features:fail('ZVM-BUILD-004','provider.required_features must be a u64')},node_fingerprint:hex(x.node_fingerprint,32,'node_fingerprint'),typescript_fingerprint:hex(x.typescript_fingerprint,32,'typescript_fingerprint'),c_fingerprint:hex(x.c_fingerprint,32,'c_fingerprint'),zig_fingerprint:hex(x.zig_fingerprint,32,'zig_fingerprint'),host_api_digest:hex(x.host_api_digest,32,'host_api_digest'),toolchain_digest:hex(x.toolchain_digest,32,'toolchain_digest'),porffor_gitlink:hex(x.porffor_gitlink,32,'porffor_gitlink'),backend_schema:u32(x.backend_schema,'backend_schema'),modification_revision:hex(x.modification_revision,32,'modification_revision'),public_interface_digest:hex(x.public_interface_digest,32,'public_interface_digest'),sources,export_registry,import_registry,field_ids:ids(x.field_ids,'field_ids'),dependencies:deps,codegen_options,descriptor};
  if(canonical.options_digest !== canonicalOptionsDigest(codegen_options)) fail('ZVM-BUILD-008','codegen options digest mismatch');
  const expected = provenance();
  if (!expected.porffor_gitlink || !expected.modification_revision || canonical.porffor_gitlink !== expected.porffor_gitlink.toLowerCase() || canonical.modification_revision !== expected.modification_revision.toLowerCase()) fail('ZVM-BUILD-011','manifest provenance disagrees with parent-injected revision');
  if(canonicalBlake3(bundle_utf8)!==canonical.bundle_digest) fail('ZVM-BUILD-008','bundle digest mismatch'); if(canonicalBlake3(source_map_utf8)!==canonical.source_map_digest) fail('ZVM-BUILD-008','source-map digest mismatch'); return canonical;
};
export const porfforPrefsForCanonicalInput = x => ({
  enjinModule: true,
  enjinModuleId: x.module_id,
  enjinProviderId: x.provider.id,
  enjinProviderAbiDigest: x.provider.abi_digest,
  enjinProviderRequiredFeatures: x.provider.required_features,
  enjinRequiredFeatures: x.descriptor.required_features,
  enjinScratchMin: x.descriptor.scratch_min,
  enjinScratchMax: x.descriptor.scratch_max,
  enjinScratchAlignment: x.descriptor.scratch_alignment,
  enjinDescriptorFlags: x.descriptor.flags,
  enjinPublicInterfaceDigest: x.public_interface_digest,
  enjinExportIds: x.export_registry.map(x => `${x.name}:${x.id}`).join(','),
  enjinImportIds: x.import_registry.map(x => `${x.id}:${x.signature_index}`).join(','),
  enjinCapabilityIds: x.descriptor.capability_registry.map(x => `${x.id}:${x.host_function_id}`).join(','),
  module: x.codegen_options.module,
  parseTypes: x.codegen_options.typescript,
  gc: x.codegen_options.gc,
  optTypes: x.codegen_options.optimize,
  ...Object.fromEntries(Object.entries(x.codegen_options)
    .filter(([k]) => !['module','typescript','gc','optimize'].includes(k))
    .map(([k,v])=>[`enjin${k.replace(/(^|_)([a-z])/g,(_,a,b)=>b.toUpperCase())}`,v])),
  enjinSourceMapDigest: x.source_map_digest,
});
export const compileCanonicalModuleInput = (raw, compile) => {
  const canonical = parseCanonicalModuleInput(raw);
  if (typeof compile !== 'function') fail('ZVM-BUILD-002', 'canonical compiler callback is required');
  return compile(canonical.bundle_utf8, porfforPrefsForCanonicalInput(canonical), canonical);
};
export const canonicalOptionsDigest = value => {
  const x = options(value);
  return canonicalBlake3(`zvm-codegen-options-v1\x00module=${x.module ? 1 : 0};typescript=${x.typescript ? 1 : 0};gc=${x.gc ? 1 : 0};optimize=${x.optimize ? 1 : 0}`);
};
