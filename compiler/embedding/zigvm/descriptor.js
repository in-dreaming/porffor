import { profileFailure } from './diagnostics.js';
import { libraryImports } from './library.js';

const hex = (value, bytes, label) => {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) profileFailure('ZVM-DESCRIPTOR-001', `${label} must be ${bytes * 2} hexadecimal digits`);
  return Array.from(Buffer.from(value, 'hex'));
};
const u16 = (out, at, value) => { out[at] = value & 255; out[at + 1] = value >>> 8; };
const u32 = (out, at, value) => { for (let i = 0; i < 4; i++) out[at + i] = (value >>> (i * 8)) & 255; };
const u64 = (out, at, value, label) => {
  let n;
  try { n = BigInt(value); } catch { profileFailure('ZVM-DESCRIPTOR-006', `${label} must be an unsigned 64-bit integer`); }
  if (n < 0n || n > 0xffffffffffffffffn) profileFailure('ZVM-DESCRIPTOR-006', `${label} must be an unsigned 64-bit integer`);
  for (let i = 0; i < 8; i++) out[at + i] = Number((n >> BigInt(i * 8)) & 255n);
};
const u32Pref = (prefs, key, fallback = 0) => {
  const value = prefs[key] ?? fallback;
  if (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 0xffffffff) profileFailure('ZVM-DESCRIPTOR-006', `--${key} must be a u32`);
  return Number(value);
};
const valueTag = type => type === 'i32' ? 2 : (type === 'f64' || type === 'number') ? 3 : type === 'void' ? 0 : null;
// Authenticated descriptor tail: 64-byte records follow signatures.  The
// frozen 344-byte header remains unchanged; this flag makes the optional
// extension unambiguous to the bounds-first artifact decoder.
const libraryImportExtension = 1;

const exportIds = prefs => {
  if (prefs.enjinExportIds == null || prefs.enjinExportIds === '') return new Map();
  const result = new Map();
  const numeric = new Set();
  for (const item of prefs.enjinExportIds.split(',')) {
    const [name, text] = item.split(':');
    const id = Number(text);
    if (!name || !Number.isInteger(id) || id <= 0 || id > 0xffffffff || result.has(name) || numeric.has(id)) profileFailure('ZVM-DESCRIPTOR-002', `invalid explicit export ID '${item}'`);
    result.set(name, id);
    numeric.add(id);
  }
  return result;
};

// These encodings contain registry IDs only. They deliberately do not infer
// identity from a name or source order: ImportId:signatureIndex and
// CapabilityId:HostFunctionId, comma separated.
const numericPairs = (prefs, key, valueLabel) => {
  const text = prefs[key];
  if (text == null || text === '') return [];
  const ids = new Set();
  const result = [];
  const items = String(text).split(',');
  if (items.length > (1 << 20)) profileFailure('ZVM-DESCRIPTOR-007', `too many ${valueLabel} mappings`);
  for (const item of items) {
    const [idText, valueText, extra] = item.split(':');
    const id = Number(idText), value = Number(valueText);
    if (extra != null || !Number.isInteger(id) || id <= 0 || id > 0xffffffff || !Number.isInteger(value) || value < 0 || value > 0xffffffff || ids.has(id))
      profileFailure('ZVM-DESCRIPTOR-007', `invalid explicit ${valueLabel} mapping '${item}'`);
    ids.add(id); result.push({ id, value });
  }
  result.sort((a, b) => a.id - b.id);
  return result;
};

export const buildDescriptor = ({ funcs, prefs, zigvm }) => {
  const ids = exportIds(prefs);
  const exports = [];
  for (const f of funcs) {
    if (!f?.export || f.name === '#main') continue;
    const name = f.exportName ?? f.name;
    const id = ids.get(name);
    if (id == null) profileFailure('ZVM-DESCRIPTOR-003', `export '${name}' has no registry ExportId`);
    const params = f.zigvmAbiParamTypes ?? [];
    const result = f.zigvmAbiReturnType;
    if (params.length > 0xffff || params.some(x => valueTag(x) == null || x === 'void') || valueTag(result) == null) profileFailure('ZVM-DESCRIPTOR-004', `export '${name}' requires at most 65535 i32/f64 parameters and an i32/f64/void result`);
    exports.push({ f, name, id, params, result });
  }
  if (ids.size !== exports.length) profileFailure('ZVM-DESCRIPTOR-005', 'registry contains an unknown export');
  exports.sort((a, b) => a.id - b.id);
  const imports = numericPairs(prefs, 'enjinImportIds', 'ImportId:signatureIndex');
  const libraryImportRecords = libraryImports(prefs);
  for (const item of libraryImportRecords) {
    if (imports.some(existing => existing.id === item.id))
      profileFailure('ZVM-DESCRIPTOR-007', `ScriptLibrary ImportId ${item.id} duplicates --enjin-import-ids`);
    imports.push({ id: item.id, value: item.signatureIndex });
  }
  imports.sort((a, b) => a.id - b.id);
  const capabilities = numericPairs(prefs, 'enjinCapabilityIds', 'CapabilityId:HostFunctionId');
  if (capabilities.some(x => x.value === 0)) profileFailure('ZVM-DESCRIPTOR-007', 'HostFunctionId must be nonzero');
  const header = 344, exportOffset = exports.length ? header : 0;
  let signaturesLength = 0;
  for (const item of exports) signaturesLength += 12 + item.params.length * 4;
  const importOffset = imports.length ? (header + exports.length * 8 + 3) & ~3 : 0;
  const capabilityOffset = capabilities.length ? ((importOffset ? importOffset + imports.length * 8 : header + exports.length * 8) + 3) & ~3 : 0;
  const tablesEnd = capabilityOffset ? capabilityOffset + capabilities.length * 8 : importOffset ? importOffset + imports.length * 8 : header + exports.length * 8;
  const signatureOffset = exports.length ? (tablesEnd + 3) & ~3 : 0;
  if (imports.some(x => x.value >= exports.length)) profileFailure('ZVM-DESCRIPTOR-007', 'import signature index is unknown');
  const libraryOffset = libraryImportRecords.length ? (signatureOffset + signaturesLength + 3) & ~3 : 0;
  const blob = new Uint8Array(libraryOffset ? libraryOffset + libraryImportRecords.length * 64 : (signatureOffset ? signatureOffset + signaturesLength : tablesEnd));
  u32(blob, 0, blob.length); u32(blob, 4, 2); u32(blob, 8, 3);
  blob.set(hex(prefs.enjinModuleId, 16, '--enjin-module-id'), 24);
  // VersionId and ArtifactContentId are derived after the completed native
  // image exists. Query always exposes a zero-ID template for host rewrite.
  blob.set(hex(prefs.enjinProviderId, 16, '--enjin-provider-id'), 104);
  blob.set(hex(prefs.enjinProviderAbiDigest, 32, '--enjin-provider-abi-digest'), 120);
  u64(blob, 16, prefs.enjinRequiredFeatures ?? 0, '--enjin-required-features');
  u64(blob, 152, prefs.enjinProviderRequiredFeatures ?? 0, '--enjin-provider-required-features');
  u32(blob, 160, 1); u32(blob, 164, 1); u32(blob, 176, exportOffset); u32(blob, 180, exports.length); u32(blob, 184, importOffset); u32(blob, 188, imports.length); u32(blob, 192, capabilityOffset); u32(blob, 196, capabilities.length); u32(blob, 216, signatureOffset); u32(blob, 220, exports.length);
  const scratchMin = u32Pref(prefs, 'enjinScratchMin');
  const scratchMax = u32Pref(prefs, 'enjinScratchMax');
  const scratchAlignment = u32Pref(prefs, 'enjinScratchAlignment', 8);
  if (scratchMin > scratchMax || scratchAlignment === 0 || (scratchAlignment & (scratchAlignment - 1)) !== 0) profileFailure('ZVM-DESCRIPTOR-006', 'invalid scratch limits or alignment');
  u32(blob, 224, scratchMin); u32(blob, 228, scratchMax); u32(blob, 232, scratchAlignment); u32(blob, 236, u32Pref(prefs, 'enjinDescriptorFlags') | (libraryImportRecords.length ? libraryImportExtension : 0));
  blob.set(hex(prefs.enjinPublicInterfaceDigest, 32, '--enjin-public-interface-digest'), 240);
  blob.set(hex(prefs.enjinSourceMapDigest, 32, '--enjin-source-map-digest'), 272);
  let signatureAt = signatureOffset;
  exports.forEach((item, index) => {
    u32(blob, exportOffset + index * 8, item.id); u32(blob, exportOffset + index * 8 + 4, index);
    u16(blob, signatureAt, 1); u16(blob, signatureAt + 4, item.params.length);
    item.params.forEach((type, i) => u32(blob, signatureAt + 8 + i * 4, valueTag(type)));
    u32(blob, signatureAt + 8 + item.params.length * 4, valueTag(item.result));
    signatureAt += 12 + item.params.length * 4;
  });
  imports.forEach((item, index) => { u32(blob, importOffset + index * 8, item.id); u32(blob, importOffset + index * 8 + 4, item.value); });
  // PORF-MOD-008: full ScriptLibrary contracts are authenticated descriptor
  // data, not generated-C comments.  The normal import table above owns the
  // signature index; this tail maps its ImportId to target and policy.
  libraryImportRecords.forEach((item, index) => {
    const at = libraryOffset + index * 64;
    u32(blob, at, item.id); u32(blob, at + 4, item.exportId);
    blob.set(hex(item.moduleId, 16, 'ScriptLibrary ModuleId'), at + 8);
    blob.set(hex(item.interfaceDigest, 32, 'ScriptLibrary interface digest'), at + 24);
    u32(blob, at + 56, item.requirement === 'optional' ? 1 : 0);
  });
  capabilities.forEach((item, index) => { u32(blob, capabilityOffset + index * 8, item.id); u32(blob, capabilityOffset + index * 8 + 4, item.value); });
  const hostImports = zigvm?.hostImports ?? [];
  for (const host of hostImports) {
    if (!capabilities.some(x => x.value === host.id)) profileFailure('ZVM-DESCRIPTOR-008', `HostCall '${host.name}' requires explicit CapabilityId:HostFunctionId metadata`);
  }
  return { blob, exports, imports, capabilities, libraryImports: libraryImportRecords };
};
