// PORF-MOD-008: ScriptLibrary import declarations are parsed at the embedded
// adapter boundary.  They use only explicit registry IDs and digests; this
// module neither resolves source imports nor creates a second JS runtime.
import { profileFailure } from './diagnostics.js';

const hex = (text, bytes, label) => {
  if (typeof text !== 'string' || !new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(text))
    profileFailure('ZVM-LIBRARY-001', `${label} must be ${bytes * 2} hexadecimal digits`);
  return text.toLowerCase();
};

// ImportId:ModuleId:ExportId:signatureIndex:interfaceDigest:required|optional
// A declaration is intentionally manifest-only until the host resolver has
// installed it into the immutable DispatchSnapshot.
export const libraryImports = prefs => {
  const text = prefs.enjinLibraryImports;
  if (text == null || text === '') return [];
  const ids = new Set();
  const result = [];
  for (const item of String(text).split(',')) {
    const [idText, moduleId, exportText, signatureText, digest, requirement, extra] = item.split(':');
    const id = Number(idText), exportId = Number(exportText), signatureIndex = Number(signatureText);
    if (extra != null || !Number.isInteger(id) || id <= 0 || id > 0xffffffff || ids.has(id) ||
        !Number.isInteger(exportId) || exportId <= 0 || exportId > 0xffffffff ||
        !Number.isInteger(signatureIndex) || signatureIndex < 0 || signatureIndex > 0xffffffff ||
        (requirement !== 'required' && requirement !== 'optional'))
      profileFailure('ZVM-LIBRARY-002', `invalid ScriptLibrary import '${item}'`);
    ids.add(id);
    result.push({ id, moduleId: hex(moduleId, 16, 'ScriptLibrary ModuleId'), exportId, signatureIndex, interfaceDigest: hex(digest, 32, 'ScriptLibrary interface digest'), requirement });
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
