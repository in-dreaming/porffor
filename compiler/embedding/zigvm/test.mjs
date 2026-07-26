import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import parse from '../../parse.js';
import codegen from '../../codegen.js';
import render from '../../render.js';
import { lowerExplicitExec } from './lowering.js';
import { renderRuntime } from './abi.js';
import { createAdapter } from './render.js';

globalThis.Prefs.zigvmEmbeddedV2 = true;
globalThis.Prefs.gc = false;
globalThis.Prefs.module = true;
globalThis.Prefs.t = true;
const cg = lowerExplicitExec(codegen(parse('export function add(a: number, b: number): number { return a + b; }\n')));
const c = render(cg);
assert.match(c, /zvm_porf_exec_ctx_v2\* exec/);
assert.match(c, /const zvm_porf_provider_api_v1\* provider/);
assert.match(c, /zvm_status_v2\* status/);
assert.doesNotMatch(c, /\bporf_mem\b/);
assert.doesNotMatch(c, /zvm_porf_runtime_api_storage/);
assert.doesNotMatch(c, /\bporf_heap_cur\b/);

const adapter = createAdapter({ enabled: true, staticEnd: 0, globals: [], hostImports: [] });
assert.match(adapter.arrayGet('array', 'index'), /zvm_porf_memory\(exec, provider\).*array\.val.*index/);
assert.match(adapter.arraySet('array', 'index', 'value'), /zvm_porf_memory\(exec, provider\).*array\.val.*index.*= value/);
assert.match(adapter.arrayLength('array'), /zvm_porf_memory\(exec, provider\).*array\.val/);
assert.match(adapter.setArrayLength('array', 'length'), /zvm_porf_memory\(exec, provider\).*array\.val.*= length/);

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'porffor-zigvm-v2-'));
const compile = (args, output) => {
  execFileSync(process.execPath, [ 'runtime/index.js', 'c', ...args, output ], { cwd: root, stdio: 'pipe' });
  return readFileSync(output, 'utf8');
};
const includeDir = resolve(root, '../../include');
const compileC = source => execFileSync('zig', [ 'cc', `-I${includeDir}`, '-c', source, '-o', `${source}.o` ], { cwd: root, stdio: 'pipe' });
const executablePath = name => join(temp, process.platform === 'win32' ? `${name}.exe` : name);
const runCompiled = name => execFileSync(executablePath(name), [], { cwd: root, stdio: 'pipe' });
const embeddedSymbol = (source, name) => {
  const match = source.match(new RegExp(`jsval (p\\d+_${name})\\(zvm_porf_exec_ctx_v2\\* exec`));
  assert.ok(match, `missing embedded export ${name}`);
  return match[1];
};

try {
  const ordinary = join(temp, 'ordinary.c');
  const legacy = join(temp, 'legacy.c');
  const embedded = join(temp, 'embedded.c');
  const trapped = join(temp, 'trapped.c');
  const nested = join(temp, 'nested.c');
  const hosted = join(temp, 'hosted.c');
  const statusCommit = join(temp, 'status-commit.c');
  const loopUpdateCommit = join(temp, 'loop-update-commit.c');
  compile([ '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/modes_fixture.ts' ], ordinary);
  compile([ '--zigvm', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/modes_fixture.ts' ], legacy);
  const embeddedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/stateful_fixture.ts' ], embedded);
  const trappedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/trap_fixture.ts' ], trapped);
  const nestedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/nested_status_fixture.ts' ], nested);
  const hostedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/host_status_fixture.ts' ], hosted);
  const statusCommitC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/status_commit_fixture.ts' ], statusCommit);
  const loopUpdateCommitC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/loop_update_status_fixture.ts' ], loopUpdateCommit);
  compileC(ordinary);
  compileC(legacy);
  compileC(embedded);
  compileC(trapped);
  compileC(nested);
  compileC(hosted);
  compileC(statusCommit);
  compileC(loopUpdateCommit);

  assert.match(embeddedC, /zvm_porf_alloc\(exec, provider/);
  assert.match(embeddedC, /zvm_porf_poll\(exec, provider/);
  assert.doesNotMatch(embeddedC, /\b(?:MEM|porf_mem|porf_heap_cur|zvm_porf_initialized)\b/);
  assert.match(trappedC, /zvm_porf_raise_trap\(exec, provider, ZVM_STATUS_V2_TRAP\)/);
  assert.match(nestedC, /zvm_porf_poll\(exec, provider, ZVM_PORF_SAFEPOINT_CALL\)[\s\S]*?p\d+_inner\(exec, provider, status,/);
  assert.match(hostedC, /zvm_porf_poll\(exec, provider, ZVM_PORF_SAFEPOINT_CALL\)[\s\S]*?zvm_porf_host_fail\(exec, provider, status\)/);
  assert.match(statusCommitC, /_zvm_status_value_0 = .*zvm_porf_host_fail[\s\S]*?if \(\*status != ZVM_STATUS_V2_OK\) return JV_UNDEFINED;[\s\S]*?zvm_porf_globals\(exec, provider\)->shared = _zvm_status_value_0;/);
  assert.match(loopUpdateCommitC, /for \(; .*; \) \{[\s\S]*?_zvm_loop_update_0:;[\s\S]*?_zvm_status_value_\d+ = .*zvm_porf_host_fail[\s\S]*?if \(\*status != ZVM_STATUS_V2_OK\) return JV_UNDEFINED;[\s\S]*?zvm_porf_globals\(exec, provider\)->shared = _zvm_status_value_\d+;/);
  assert.match(loopUpdateCommitC, /if \(i == 0\.0\) \{[\s\S]*?goto _zvm_loop_update_0;[\s\S]*?_zvm_loop_update_0:;[\s\S]*?i = _zvm_status_value_\d+;/);

  assert.throws(
    () => compile([ '--zigvm-embedded-v2', '--no-gc', '--module', 'bench/strcat.js' ], join(temp, 'strcat.c')),
    /performance .*console|console .*performance/,
    'v2 must reject retained ordinary-runtime helpers before generating C'
  );

  const enjin = join(temp, 'enjin-module.c');
  const library = join(temp, 'library-module.c');
  const enjinArgs = [ '--enjin-module', '--no-gc', '--module', '-t', '--enjin-module-id=01010101010101010101010101010101', '--enjin-provider-id=02020202020202020202020202020202', '--enjin-provider-abi-digest=0303030303030303030303030303030303030303030303030303030303030303', '--enjin-public-interface-digest=0606060606060606060606060606060606060606060606060606060606060606', '--enjin-source-map-digest=0707070707070707070707070707070707070707070707070707070707070707', '--enjin-scratch-min=8', '--enjin-scratch-max=64', '--enjin-scratch-alignment=8', '--enjin-export-ids=add:42', '--enjin-import-ids=9:0,3:0', '--enjin-capability-ids=7:42,2:9' ];
  const enjinC = compile([ ...enjinArgs, '../../test/porffor/v2_fixture.ts' ], enjin);
  const libraryC = compile([ ...enjinArgs, '--enjin-library-imports=5:11111111111111111111111111111111:7:0:2222222222222222222222222222222222222222222222222222222222222222:required', '--enjin-export-ids=run:42', 'compiler/embedding/zigvm/library_fixture.ts' ], library);
  compileC(enjin);
  compileC(library);
  assert.match(enjinC, /zvm_porf_module_query_v2\(void\* out, u32 capacity, u32\* required\)/);
  assert.match(enjinC, /case 42u:/);
  assert.match(enjinC, /0x03u, 0x00u, 0x00u, 0x00u/);
  assert.match(enjinC, /zvm_porf_call_v2\(zvm_porf_exec_ctx_v2\* exec, u32 export_id/);
  assert.match(libraryC, /zvm_porf_library_i32\(exec, provider, status, 5u/);
  assert.match(libraryC, /0x80000000u \| import_id/);
  const enjinDll = join(temp, process.platform === 'win32' ? 'enjin-module.dll' : 'enjin-module.so');
  execFileSync('zig', [ 'cc', '-shared', '-Wl,--export-all-symbols', `-I${includeDir}`, enjin, '-o', enjinDll ], { cwd: root, stdio: 'pipe' });
  const dllHarness = join(temp, 'enjin_dll_harness.c');
  writeFileSync(dllHarness, `#include <string.h>
#include <stdint.h>
#include "zigvm/porffor_embedded_v2.h"
#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#endif
static unsigned char linear[1024];
static void *base(zvm_porf_exec_ctx_v2 *e) { (void)e; return linear; }
static bool reserve(zvm_porf_exec_ctx_v2 *e, uint32_t n) { (void)e; (void)n; return true; }
static bool commit(zvm_porf_exec_ctx_v2 *e, uint32_t n) { (void)e; (void)n; return true; }
static void *scratch(zvm_porf_exec_ctx_v2 *e, uint32_t n, uint32_t a) { (void)e; (void)n; (void)a; return 0; }
static void reset(zvm_porf_exec_ctx_v2 *e) { (void)e; }
static zvm_status_v2 host(zvm_porf_exec_ctx_v2 *e, uint32_t i, const zvm_value_v2 *a, uint32_t n, zvm_value_v2 *r) { (void)e; (void)i; (void)a; (void)n; (void)r; return ZVM_STATUS_V2_OK; }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2 *e, uint32_t f) { (void)e; (void)f; return ZVM_STATUS_V2_OK; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2 *e, uint32_t c) { (void)e; (void)c; return ZVM_STATUS_V2_TRAP; }
static uint64_t budget(zvm_porf_exec_ctx_v2 *e) { (void)e; return 1; }
static bool cancelled(zvm_porf_exec_ctx_v2 *e) { (void)e; return false; }
int main(int argc, char **argv) {
#ifdef _WIN32
  HMODULE image = LoadLibraryA(argv[1]); if (!image) return 1;
  zvm_status_v2 (*query)(void *, uint32_t, uint32_t *) = (void *)GetProcAddress(image, "zvm_porf_module_query_v2");
  zvm_status_v2 (*call)(zvm_porf_exec_ctx_v2 *, uint32_t, uint32_t, const zvm_value_v2 *, uint32_t, zvm_value_v2 *) = (void *)GetProcAddress(image, "zvm_porf_call_v2");
#else
  void *image = dlopen(argv[1], RTLD_NOW); if (!image) return 1;
  zvm_status_v2 (*query)(void *, uint32_t, uint32_t *) = dlsym(image, "zvm_porf_module_query_v2");
  zvm_status_v2 (*call)(zvm_porf_exec_ctx_v2 *, uint32_t, uint32_t, const zvm_value_v2 *, uint32_t, zvm_value_v2 *) = dlsym(image, "zvm_porf_call_v2");
#endif
  if (!query || !call) return 2; uint32_t required = 0; if (query(0, 0, &required) != 0 || required < ZVM_DESCRIPTOR_V2_KNOWN_SIZE) return 3;
  unsigned char descriptor[512]; if (required > sizeof descriptor || query(descriptor, sizeof descriptor, &required) != 0 || descriptor[40] != 0 || descriptor[72] != 0 || descriptor[224] != 8) return 4;
  zvm_porf_provider_api_v1 api = { sizeof api, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, scratch, reset, host, poll, trap, budget, cancelled };
  zvm_porf_exec_boundary_v2 boundary = { ZVM_PORF_EXEC_BOUNDARY_V2_MAGIC, sizeof boundary, &api, {{2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2}}, {{3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3}}, 0, 17, 1 };
  zvm_value_v2 args[2] = { { ZVM_VALUE_V2_F64, 0, 0x3ff0000000000000ULL }, { ZVM_VALUE_V2_F64, 0, 0x4000000000000000ULL } }, result = {0};
  zvm_status_v2 status = call((zvm_porf_exec_ctx_v2 *)&boundary, 42, 17, args, 2, &result); if (status != 0) return 10 + status; if (result.tag != ZVM_VALUE_V2_F64 || result.payload != 0x4008000000000000ULL) return 5;
  boundary.logical_instance_token = 18; if (call((zvm_porf_exec_ctx_v2 *)&boundary, 42, 17, args, 2, &result) != ZVM_STATUS_V2_PROVIDER_MISMATCH) return 6;
  return 0;
}`);
  execFileSync('zig', [ 'cc', `-I${includeDir}`, dllHarness, '-o', executablePath('enjin_dll_harness') ], { cwd: root, stdio: 'pipe' });
  execFileSync(executablePath('enjin_dll_harness'), [ enjinDll ], { cwd: root, stdio: 'pipe' });
  // This exercises the exact DLL through the Zig loader boundary: it resolves
  // query/call, derives and verifies an envelope over this image, normalizes
  // the zero-ID query template, then invokes numeric export 42 via Module.
  execFileSync('zig', [ 'run', '../../src/runtime/porffor_embedded_v2_dll_runner.zig', '--', enjinDll ], { cwd: root, stdio: 'pipe' });
  const registryBase = enjinArgs.filter(x => !x.startsWith('--enjin-import-ids=') && !x.startsWith('--enjin-capability-ids='));
  for (const args of [
    [ '--enjin-import-ids=2:0,2:0' ],
    [ '--enjin-import-ids=2:9' ],
    [ '--enjin-capability-ids=2:0' ],
    [ '--enjin-capability-ids=2:9,2:10' ],
  ]) assert.throws(() => compile([ ...registryBase, ...args, '../../test/porffor/v2_fixture.ts' ], join(temp, 'bad-registry.c')), /ZVM-DESCRIPTOR-007/);
  const badProfile = join(temp, 'bad-profile.ts');
  writeFileSync(badProfile, 'let state: i32 = 1; export function add(a: i32): i32 { return a; }');
  assert.throws(
    () => compile([ ...enjinArgs, badProfile ], join(temp, 'bad-profile.c')),
    /ZVM-PROFILE-001/,
    'gameplay profile rejects mutable globals before C rendering'
  );
  const canonicalHostCall = join(temp, 'canonical-host-call.ts');
  writeFileSync(canonicalHostCall, 'const { host } = Porffor.dlopen("__zigvm_host__", { host: { id: 42, parameters: [], result: "i32" } }); export function add(a: i32, b: i32): i32 { return a + b; }');
  compile([ ...enjinArgs, canonicalHostCall ], join(temp, 'canonical-host-call.c'));
  for (const [code, source] of [
    [ 'ZVM-PROFILE-001', 'export let state: i32 = 1;' ],
    [ 'ZVM-PROFILE-004', 'const run = eval; run("1");' ],
    [ 'ZVM-PROFILE-004', '(0, eval)("1");' ],
    [ 'ZVM-PROFILE-004', 'globalThis.eval("1");' ],
    [ 'ZVM-PROFILE-004', 'const g = globalThis; g.eval("1");' ],
    [ 'ZVM-PROFILE-005', 'Porffor["dlopen"]("not-host", 0);' ],
    [ 'ZVM-PROFILE-005', 'const p = Porffor; p.dlopen("not-host", 0);' ],
    [ 'ZVM-PROFILE-005', 'Porffor["dlo" + "pen"]("not-host", 0);' ],
    [ 'ZVM-PROFILE-005', 'Porffor.dlopen("not-host", 0);' ],
    [ 'ZVM-PROFILE-002', 'import("other");' ],
    [ 'ZVM-PROFILE-003', 'async function f() { await 1; }' ],
    [ 'ZVM-PROFILE-003', 'try { 1; } catch (e) {}' ],
  ]) {
    const sourcePath = join(temp, `profile-${code}.ts`);
    writeFileSync(sourcePath, source);
    assert.throws(() => compile([ ...enjinArgs, sourcePath ], join(temp, `profile-${code}.c`)), new RegExp(code));
  }

  // Include the generated TU so the test can call its internal function with
  // two independent explicit execution contexts.
  const harness = join(temp, 'interleave.c');
  writeFileSync(harness, `#include "embedded.c"
struct zvm_porf_exec_ctx_v2 { unsigned char memory[256]; unsigned capacity; unsigned polls; unsigned traps; unsigned hosts; zvm_status_v2 poll_status; };
static void* base(zvm_porf_exec_ctx_v2* exec) { return exec->memory; }
static bool reserve(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return bytes <= exec->capacity; }
static bool commit(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return reserve(exec, bytes); }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2* exec, u32 flags) { (void)flags; exec->polls++; return exec->poll_status; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2* exec, u32 code) { (void)code; exec->traps++; return ZVM_STATUS_V2_TRAP; }
static zvm_status_v2 host(zvm_porf_exec_ctx_v2* exec, zvm_host_function_id_v2 id, const zvm_value_v2* args, u32 count, zvm_value_v2* result) { (void)id; (void)args; (void)count; (void)result; exec->hosts++; return ZVM_STATUS_V2_CANCELLED; }
int main(void) {
  const zvm_porf_provider_api_v1 provider = { sizeof provider, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, 0, 0, host, poll, trap, 0, 0 };
  zvm_porf_exec_ctx_v2 first = { .capacity = 256 }, second = { .capacity = 256 }, short_arena = { .capacity = 1 }; zvm_status_v2 status = ZVM_STATUS_V2_OK;
  if (sizeof zvm_porf_static_image != PORF_STATIC_END) return 1;
  memcpy(first.memory, zvm_porf_static_image, sizeof zvm_porf_static_image);
  memcpy(second.memory, zvm_porf_static_image, sizeof zvm_porf_static_image);
  if (*(u32*)(first.memory + 16u) != 11u || memcmp(first.memory + 20u, "per-context", 11u) != 0) return 2;
  first.memory[20] = 'x';
  if (second.memory[20] != 'p') return 3;
  jsval a = p1_allocateAndLoop(&first, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(3));
  if (status != ZVM_STATUS_V2_OK || (u32)a.val == 0u || first.polls != 3u) return 4;
  status = ZVM_STATUS_V2_OK;
  jsval b = p1_allocateAndLoop(&second, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(2));
  if (status != ZVM_STATUS_V2_OK || (u32)b.val == 0u || second.polls != 2u || first.memory[0] != 0u) return 5;
  first.poll_status = ZVM_STATUS_V2_CANCELLED; status = ZVM_STATUS_V2_OK;
  (void)p1_allocateAndLoop(&first, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(1));
  if (status != ZVM_STATUS_V2_CANCELLED) return 6;
  status = ZVM_STATUS_V2_OK;
  (void)p1_allocateAndLoop(&short_arena, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(1));
  if (status != ZVM_STATUS_V2_INTERNAL) return 7;
  return 0;
}
`);
  execFileSync('zig', [ 'cc', `-I${includeDir}`, harness, '-o', executablePath('interleave') ], { cwd: root, stdio: 'pipe' });
  runCompiled('interleave');

  const nestedHarness = join(temp, 'nested_status.c');
  const hostHarness = join(temp, 'host_status.c');
  const nestedSymbol = embeddedSymbol(nestedC, 'nestedTrap');
  const recursiveSymbol = embeddedSymbol(nestedC, 'recursivePoll');
  const hostSymbol = embeddedSymbol(hostedC, 'hostThenAllocate');
  writeFileSync(nestedHarness, `#include "nested.c"
struct zvm_porf_exec_ctx_v2 { unsigned char memory[256]; unsigned capacity; unsigned polls; unsigned traps; unsigned hosts; zvm_status_v2 poll_status; };
static void* base(zvm_porf_exec_ctx_v2* exec) { return exec->memory; }
static bool reserve(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return bytes <= exec->capacity; }
static bool commit(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return reserve(exec, bytes); }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2* exec, u32 flags) { (void)flags; exec->polls++; return exec->poll_status; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2* exec, u32 code) { (void)code; exec->traps++; return ZVM_STATUS_V2_TRAP; }
static zvm_status_v2 host(zvm_porf_exec_ctx_v2* exec, zvm_host_function_id_v2 id, const zvm_value_v2* args, u32 count, zvm_value_v2* result) { (void)id; (void)args; (void)count; (void)result; exec->hosts++; return ZVM_STATUS_V2_CANCELLED; }
int main(void) {
  const zvm_porf_provider_api_v1 provider = { sizeof provider, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, 0, 0, host, poll, trap, 0, 0 };
  zvm_porf_exec_ctx_v2 exec = { .capacity = 256 }; zvm_status_v2 status = ZVM_STATUS_V2_OK;
  (void)${nestedSymbol}(&exec, &provider, &status, JV_UNDEFINED, JV_UNDEFINED);
  if (status != ZVM_STATUS_V2_TRAP || exec.polls != 1 || exec.traps != 1 || exec.memory[0] != 0) return 1;
  exec.poll_status = ZVM_STATUS_V2_CANCELLED; status = ZVM_STATUS_V2_OK;
  (void)${nestedSymbol}(&exec, &provider, &status, JV_UNDEFINED, JV_UNDEFINED);
  if (status != ZVM_STATUS_V2_CANCELLED || exec.polls != 2 || exec.traps != 1) return 2;
  exec.poll_status = ZVM_STATUS_V2_OK; status = ZVM_STATUS_V2_OK;
  if (${recursiveSymbol}(&exec, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(2)).val != 2.0 || status != ZVM_STATUS_V2_OK || exec.polls != 5) return 3;
  return 0;
}
`);
  execFileSync('zig', [ 'cc', `-I${includeDir}`, nestedHarness, '-o', executablePath('nested-status') ], { cwd: root, stdio: 'pipe' });
  runCompiled('nested-status');

  writeFileSync(hostHarness, `#include "hosted.c"
struct zvm_porf_exec_ctx_v2 { unsigned char memory[256]; unsigned capacity; unsigned polls; unsigned traps; unsigned hosts; zvm_status_v2 poll_status; };
static void* base(zvm_porf_exec_ctx_v2* exec) { return exec->memory; }
static bool reserve(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return bytes <= exec->capacity; }
static bool commit(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return reserve(exec, bytes); }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2* exec, u32 flags) { (void)flags; exec->polls++; return exec->poll_status; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2* exec, u32 code) { (void)code; exec->traps++; return ZVM_STATUS_V2_TRAP; }
static zvm_status_v2 host(zvm_porf_exec_ctx_v2* exec, zvm_host_function_id_v2 id, const zvm_value_v2* args, u32 count, zvm_value_v2* result) { (void)id; (void)args; (void)count; (void)result; exec->hosts++; return ZVM_STATUS_V2_CANCELLED; }
int main(void) {
  const zvm_porf_provider_api_v1 provider = { sizeof provider, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, 0, 0, host, poll, trap, 0, 0 };
  zvm_porf_exec_ctx_v2 exec = { .capacity = 256 }; zvm_status_v2 status = ZVM_STATUS_V2_OK;
  (void)${hostSymbol}(&exec, &provider, &status, JV_UNDEFINED, JV_UNDEFINED);
  if (status != ZVM_STATUS_V2_CANCELLED || exec.polls != 1 || exec.hosts != 1 || exec.memory[0] != 0) return 1;
  exec.poll_status = ZVM_STATUS_V2_CANCELLED; status = ZVM_STATUS_V2_OK;
  (void)${hostSymbol}(&exec, &provider, &status, JV_UNDEFINED, JV_UNDEFINED);
  return status == ZVM_STATUS_V2_CANCELLED && exec.polls == 2 && exec.hosts == 1 ? 0 : 2;
}
`);
  execFileSync('zig', [ 'cc', `-I${includeDir}`, hostHarness, '-o', executablePath('host-status') ], { cwd: root, stdio: 'pipe' });
  runCompiled('host-status');

  const statusCommitHarness = join(temp, 'status-commit.c.test.c');
  const globalSymbol = embeddedSymbol(statusCommitC, 'globalAssignment');
  writeFileSync(statusCommitHarness, `#include "status-commit.c"
struct zvm_porf_exec_ctx_v2 { unsigned char memory[256]; unsigned capacity; zvm_status_v2 host_status; };
static void* base(zvm_porf_exec_ctx_v2* exec) { return exec->memory; }
static bool reserve(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return bytes <= exec->capacity; }
static bool commit(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return reserve(exec, bytes); }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2* exec, u32 flags) { (void)exec; (void)flags; return ZVM_STATUS_V2_OK; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2* exec, u32 code) { (void)exec; (void)code; return ZVM_STATUS_V2_TRAP; }
static zvm_status_v2 host(zvm_porf_exec_ctx_v2* exec, zvm_host_function_id_v2 id, const zvm_value_v2* args, u32 count, zvm_value_v2* result) { (void)id; (void)args; (void)count; (void)result; return exec->host_status; }
static int check(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2 failure) {
  zvm_status_v2 status = ZVM_STATUS_V2_OK;
  zvm_porf_globals(exec, provider)->shared = porf_box_num(41);
  exec->host_status = failure;
  (void)${globalSymbol}(exec, provider, &status, JV_UNDEFINED, JV_UNDEFINED);
  return status == failure && zvm_porf_globals(exec, provider)->shared.val == 41.0;
}
int main(void) {
  const zvm_porf_provider_api_v1 provider = { sizeof provider, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, 0, 0, host, poll, trap, 0, 0 };
  zvm_porf_exec_ctx_v2 exec = { .capacity = 256 };
  return check(&exec, &provider, ZVM_STATUS_V2_TRAP) && check(&exec, &provider, ZVM_STATUS_V2_CANCELLED) && check(&exec, &provider, ZVM_STATUS_V2_BUDGET_EXCEEDED) ? 0 : 1;
}
`);
  execFileSync('zig', [ 'cc', `-I${includeDir}`, statusCommitHarness, '-o', executablePath('status-commit') ], { cwd: root, stdio: 'pipe' });
  runCompiled('status-commit');

  const loopUpdateCommitHarness = join(temp, 'loop-update-commit.c.test.c');
  const loopUpdateSymbol = embeddedSymbol(loopUpdateCommitC, 'forUpdateAssignment');
  const continueSymbol = embeddedSymbol(loopUpdateCommitC, 'continueUpdate');
  writeFileSync(loopUpdateCommitHarness, `#include "loop-update-commit.c"
struct zvm_porf_exec_ctx_v2 { unsigned char memory[256]; unsigned capacity; zvm_status_v2 host_status; };
static void* base(zvm_porf_exec_ctx_v2* exec) { return exec->memory; }
static bool reserve(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return bytes <= exec->capacity; }
static bool commit(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return reserve(exec, bytes); }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2* exec, u32 flags) { (void)exec; (void)flags; return ZVM_STATUS_V2_OK; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2* exec, u32 code) { (void)exec; (void)code; return ZVM_STATUS_V2_TRAP; }
static zvm_status_v2 host(zvm_porf_exec_ctx_v2* exec, zvm_host_function_id_v2 id, const zvm_value_v2* args, u32 count, zvm_value_v2* result) { (void)id; (void)args; (void)count; (void)result; return exec->host_status; }
static int check(zvm_porf_exec_ctx_v2* exec, const zvm_porf_provider_api_v1* provider, zvm_status_v2 failure) {
  zvm_status_v2 status = ZVM_STATUS_V2_OK;
  zvm_porf_globals(exec, provider)->shared = porf_box_num(41);
  exec->host_status = failure;
  (void)${loopUpdateSymbol}(exec, provider, &status, JV_UNDEFINED, JV_UNDEFINED);
  return status == failure && zvm_porf_globals(exec, provider)->shared.val == 41.0;
}
int main(void) {
  const zvm_porf_provider_api_v1 provider = { sizeof provider, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, 0, 0, host, poll, trap, 0, 0 };
  zvm_porf_exec_ctx_v2 exec = { .capacity = 256 };
  if (!check(&exec, &provider, ZVM_STATUS_V2_TRAP) || !check(&exec, &provider, ZVM_STATUS_V2_CANCELLED) || !check(&exec, &provider, ZVM_STATUS_V2_BUDGET_EXCEEDED)) return 1;
  zvm_status_v2 status = ZVM_STATUS_V2_OK;
  exec.host_status = ZVM_STATUS_V2_OK;
  return ${continueSymbol}(&exec, &provider, &status, JV_UNDEFINED, JV_UNDEFINED).val == 1.0 && status == ZVM_STATUS_V2_OK ? 0 : 2;
}
`);
  execFileSync('zig', [ 'cc', `-I${includeDir}`, loopUpdateCommitHarness, '-o', executablePath('loop-update-commit') ], { cwd: root, stdio: 'pipe' });
  runCompiled('loop-update-commit');

  const hostRuntime = renderRuntime({ staticEnd: 0, globals: [], hostImports: [ { id: 1, name: 'host', parameters: [], result: 'i32' } ] });
  assert.match(hostRuntime, /if \(\*status == ZVM_STATUS_V2_OK\) \*status = provider->host_dispatch/);
  assert.match(hostRuntime, /provider->raise_trap/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
