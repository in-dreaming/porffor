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
  compile([ '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/modes_fixture.ts' ], ordinary);
  compile([ '--zigvm', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/modes_fixture.ts' ], legacy);
  const embeddedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/stateful_fixture.ts' ], embedded);
  const trappedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/trap_fixture.ts' ], trapped);
  const nestedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/nested_status_fixture.ts' ], nested);
  const hostedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/host_status_fixture.ts' ], hosted);
  const statusCommitC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/status_commit_fixture.ts' ], statusCommit);
  compileC(ordinary);
  compileC(legacy);
  compileC(embedded);
  compileC(trapped);
  compileC(nested);
  compileC(hosted);
  compileC(statusCommit);

  assert.match(embeddedC, /zvm_porf_alloc\(exec, provider/);
  assert.match(embeddedC, /zvm_porf_poll\(exec, provider/);
  assert.doesNotMatch(embeddedC, /\b(?:MEM|porf_mem|porf_heap_cur|zvm_porf_initialized)\b/);
  assert.match(trappedC, /zvm_porf_raise_trap\(exec, provider, ZVM_STATUS_V2_TRAP\)/);
  assert.match(nestedC, /zvm_porf_poll\(exec, provider, ZVM_PORF_SAFEPOINT_CALL\)[\s\S]*?p\d+_inner\(exec, provider, status,/);
  assert.match(hostedC, /zvm_porf_poll\(exec, provider, ZVM_PORF_SAFEPOINT_CALL\)[\s\S]*?zvm_porf_host_fail\(exec, provider, status\)/);
  assert.match(statusCommitC, /_zvm_status_value_0 = .*zvm_porf_host_fail[\s\S]*?if \(\*status != ZVM_STATUS_V2_OK\) return JV_UNDEFINED;[\s\S]*?zvm_porf_globals\(exec, provider\)->shared = _zvm_status_value_0;/);

  assert.throws(
    () => compile([ '--zigvm-embedded-v2', '--no-gc', '--module', 'bench/strcat.js' ], join(temp, 'strcat.c')),
    /performance .*console|console .*performance/,
    'v2 must reject retained ordinary-runtime helpers before generating C'
  );

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

  const hostRuntime = renderRuntime({ staticEnd: 0, globals: [], hostImports: [ { id: 1, name: 'host', parameters: [], result: 'i32' } ] });
  assert.match(hostRuntime, /if \(\*status == ZVM_STATUS_V2_OK\) \*status = provider->host_dispatch/);
  assert.match(hostRuntime, /provider->raise_trap/);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
