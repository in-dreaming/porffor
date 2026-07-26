// PORF-MOD-008: ScriptLibrary import declarations are parsed at the embedded
// adapter boundary.  They use only explicit registry IDs and digests; this
// module neither resolves source imports nor creates a second JS runtime.
import { profileFailure } from './diagnostics.js';

const hex = (text, bytes, label) => {
  if (typeof text !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(text))
    profileFailure('ZVM-LIBRARY-001', `${label} must be ${bytes * 2} hexadecimal digits`);
  return text.toLowerCase();
};

// ImportId:ModuleId:ExportId:signatureIndex:interfaceDigest:required|optional[:fallback]
// A declaration is intentionally manifest-only until the host resolver has
// installed it into the immutable DispatchSnapshot.
const fallbackValue = (text, requirement) => {
  if (requirement !== 'optional') {
    if (text != null) profileFailure('ZVM-LIBRARY-002', 'required ScriptLibrary imports cannot declare a fallback');
    return { tag: 0, aux: 0, payload: 0n };
  }
  if (text == null || text === '' || text === 'undefined') return { tag: 0, aux: 0, payload: 0n };
  const [kind, value, extra] = text.split('=');
  if (extra != null || value == null) profileFailure('ZVM-LIBRARY-002', `invalid optional ScriptLibrary fallback '${text}'`);
  if (kind === 'i32') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) profileFailure('ZVM-LIBRARY-002', `invalid i32 fallback '${text}'`);
    return { tag: 2, aux: 0, payload: BigInt.asUintN(64, BigInt(number)) };
  }
  if (kind === 'f64') {
    const number = Number(value);
    if (!Number.isFinite(number)) profileFailure('ZVM-LIBRARY-002', `invalid f64 fallback '${text}'`);
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, number, true);
    return { tag: 3, aux: 0, payload: new DataView(bytes).getBigUint64(0, true) };
  }
  profileFailure('ZVM-LIBRARY-002', `unsupported optional ScriptLibrary fallback '${text}'`);
};

export const libraryImports = prefs => {
  const text = prefs.enjinLibraryImports;
  if (text == null || text === '') return [];
  const ids = new Set();
  const result = [];
  for (const item of String(text).split(',')) {
    const [idText, moduleId, exportText, signatureText, digest, requirement, fallback, extra] = item.split(':');
    const id = Number(idText), exportId = Number(exportText), signatureIndex = Number(signatureText);
    // The high bit is the generated HostFunctionId dispatch namespace.  It
    // is not part of ImportId, otherwise `1` and `0x80000001` alias after
    // the runtime strips the dispatch bit.
    if (extra != null || !Number.isInteger(id) || id <= 0 || id > 0x7fffffff || ids.has(id) ||
        !Number.isInteger(exportId) || exportId <= 0 || exportId > 0xffffffff ||
        !Number.isInteger(signatureIndex) || signatureIndex < 0 || signatureIndex > 0xffffffff ||
        (requirement !== 'required' && requirement !== 'optional'))
      profileFailure('ZVM-LIBRARY-002', `invalid ScriptLibrary import '${item}'`);
    ids.add(id);
    result.push({ id, moduleId: hex(moduleId, 16, 'ScriptLibrary ModuleId'), exportId, signatureIndex, interfaceDigest: hex(digest, 32, 'ScriptLibrary interface digest'), requirement, fallback: fallbackValue(fallback, requirement) });
  }
  result.sort((a, b) => a.id - b.id);
  return result;
};

export const lowerLibraryImports = (cg, prefs) => {
  const imports = libraryImports(prefs);
  // Keep lowering data isolated from generic IR. Renderer hooks only consume
  // it to emit authenticated metadata; invocation goes through zigvm's host
  // resolver, which supplies the caller's active exec boundary.
  cg.zigvmLibraryImports = imports;
  return imports;
};

export const libraryImportById = prefs => new Map(libraryImports(prefs).map(item => [item.id, item]));
