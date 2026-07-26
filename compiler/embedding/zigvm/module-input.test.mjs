import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalBlake3, canonicalOptionsDigest, compileCanonicalModuleInput, parseCanonicalModuleInput } from './module-input.js';
const provenance = JSON.parse(fs.readFileSync(new URL('../../../../../src/compiler/script_module/build_provenance.json', import.meta.url)));
const h = n => n.toString(16).padStart(2, '0').repeat(32);
const sourceMap = JSON.stringify({ version: 3, sources: ['a.ts'], names: [], mappings: '' });
const source = 'export const run = (x: i32): i32 => x;';
const opts = { module:true, typescript:true, gc:false, optimize:true };
const base = () => ({ schema_version: 1, module_id: '01'.repeat(16), canonical_manifest_digest:h(2), state_schema_digest:h(3), source_graph_digest:h(4), profile:'gameplay', target:'x86_64-windows', cpu:'baseline', options_digest:canonicalOptionsDigest(opts), artifact_version:2, abi_version:2, bundle_utf8:source, bundle_digest:canonicalBlake3(source), source_map_utf8:sourceMap, source_map_digest:canonicalBlake3(sourceMap), provider:{id:'06'.repeat(16),abi_digest:h(7),required_features:0}, node_fingerprint:h(8),typescript_fingerprint:h(9),c_fingerprint:h(10),zig_fingerprint:h(11),host_api_digest:h(12),toolchain_digest:h(15),porffor_gitlink:provenance.porffor_gitlink,backend_schema:1,modification_revision:provenance.modification_revision,public_interface_digest:h(16),descriptor:{required_features:0,scratch_min:0,scratch_max:4096,scratch_alignment:8,flags:0,capability_registry:[]},sources:[{logical_path:'z.ts',utf8:'z',digest:canonicalBlake3('z')},{logical_path:'a.ts',utf8:'a',digest:canonicalBlake3('a')}],export_registry:[{name:'run',id:1}],import_registry:[],field_ids:[],dependencies:[],codegen_options:{...opts} });
const parsed = parseCanonicalModuleInput(base());
assert.deepEqual(parsed.sources.map(x=>x.logical_path), ['a.ts','z.ts']);
for (const mutate of [x=>x.bundle_digest=h(99),x=>x.sources[0].digest=h(99),x=>x.source_map_utf8='{}',x=>x.source_map_utf8=JSON.stringify({version:3,sources:['C:/bad.ts'],names:[],mappings:''}),x=>x.sources[0].logical_path='C:/bad.ts',x=>x.sources[0].logical_path='\\\\server\\bad.ts',x=>x.sources[0].logical_path='../bad.ts',x=>x.module_id='00'.repeat(16),x=>x.provider.required_features='1',x=>x.bundle_utf8='',x=>x.bundle_utf8='x'.repeat(1025),x=>x.unknown=true,x=>x.codegen_options.unknown=true,x=>x.codegen_options.gc='false',x=>x.codegen_options.gc=true,x=>x.export_registry=[{name:'run',id:1},{name:'run',id:2}],x=>x.options_digest=h(99),x=>x.porffor_gitlink=h(99),x=>x.modification_revision=h(99),x=>x.dependencies={},x=>x.sources[0].utf8='\ud800']) assert.throws(()=>{const v=base(); mutate(v); parseCanonicalModuleInput(v);}, /ZVM-BUILD-/);
assert.throws(()=>parseCanonicalModuleInput({...base(), cancelled:true}), /ZVM-BUILD-012/);
assert.throws(()=>parseCanonicalModuleInput({...base(), source_map_utf8:'not json'}),/ZVM-BUILD-009/);
assert.equal(canonicalBlake3('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
assert.equal(compileCanonicalModuleInput(base(), (bundle, prefs, input) => `${bundle}:${prefs.module}:${input.module_id}`), `${source}:true:${'01'.repeat(16)}`);
// Exercise the production compiler callback and the narrow CLI route. These
// runs never give Porffor a physical source path: only the authenticated bundle
// is compiled and the generated C must not leak the temporary manifest root.
const roots = [fs.mkdtempSync(path.join(os.tmpdir(), 'zvm-canonical-a-')), fs.mkdtempSync(path.join(os.tmpdir(), 'zvm-canonical-b-'))];
const outputs = [];
try { for (const temp of roots) {
  const manifest = base();
  const manifestPath = path.join(temp, 'input.json');
  const programmaticOut = path.join(temp, 'programmatic.c');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const { default: compiler } = await import('../../index.js');
  compileCanonicalModuleInput(manifest, (bundle, prefs) => {
    Object.assign(globalThis.Prefs, prefs, { target: 'c', o: programmaticOut, quiet: true });
    return compiler(bundle, prefs.module, false);
  });
  assert.match(fs.readFileSync(programmaticOut, 'utf8'), /zvm_porf_module_query_v2/);
  assert.ok(!fs.readFileSync(programmaticOut, 'utf8').includes(temp));
  const cliOut = path.join(temp, 'cli.c');
  execFileSync(process.execPath, [
      'runtime/index.js',
      'c',
      `--enjin-module-input=${manifestPath}`,
      cliOut,
    ], {
      cwd: path.resolve(import.meta.dirname, '../../..'),
    });
  const programmatic = fs.readFileSync(programmaticOut, 'utf8');
  const cli = fs.readFileSync(cliOut, 'utf8');
  assert.match(cli, /zvm_porf_module_query_v2/);
  assert.ok(!cli.includes(temp));
  outputs.push({ canonical: JSON.stringify(parseCanonicalModuleInput(manifest)), programmatic, cli });
} assert.deepEqual(outputs[0], outputs[1]);
} finally { for (const temp of roots) fs.rmSync(temp, { recursive: true, force: true }); }
console.log('canonical module input: PASS');
