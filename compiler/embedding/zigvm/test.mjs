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

const root = fileURLToPath(new URL('../../../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'porffor-zigvm-v2-'));
const compile = (args, output) => {
  execFileSync(process.execPath, [ 'runtime/index.js', 'c', ...args, output ], { cwd: root, stdio: 'pipe' });
  return readFileSync(output, 'utf8');
};
const compileC = source => execFileSync('zig', [ 'cc', `-I${resolve(root, '../../include')}`, '-c', source, '-o', `${source}.o` ], { cwd: root, stdio: 'pipe' });

try {
  const ordinary = join(temp, 'ordinary.c');
  const legacy = join(temp, 'legacy.c');
  const embedded = join(temp, 'embedded.c');
  const trapped = join(temp, 'trapped.c');
  compile([ '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/modes_fixture.ts' ], ordinary);
  compile([ '--zigvm', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/modes_fixture.ts' ], legacy);
  const embeddedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/stateful_fixture.ts' ], embedded);
  const trappedC = compile([ '--zigvm-embedded-v2', '--no-gc', '--module', '-t', 'compiler/embedding/zigvm/trap_fixture.ts' ], trapped);
  compileC(ordinary);
  compileC(legacy);
  compileC(embedded);
  compileC(trapped);

  assert.match(embeddedC, /zvm_porf_alloc\(exec, provider/);
  assert.match(embeddedC, /zvm_porf_poll\(exec, provider/);
  assert.doesNotMatch(embeddedC, /\b(?:MEM|porf_mem|porf_heap_cur|zvm_porf_initialized)\b/);
  assert.match(trappedC, /zvm_porf_raise_trap\(exec, provider, ZVM_STATUS_V2_TRAP\)/);

  // Include the generated TU so the test can call its internal function with
  // two independent explicit execution contexts.
  const harness = join(temp, 'interleave.c');
  writeFileSync(harness, `#include "embedded.c"
struct zvm_porf_exec_ctx_v2 { unsigned char memory[256]; unsigned polls; zvm_status_v2 poll_status; };
static void* base(zvm_porf_exec_ctx_v2* exec) { return exec->memory; }
static bool reserve(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return bytes <= sizeof exec->memory; }
static bool commit(zvm_porf_exec_ctx_v2* exec, u32 bytes) { return reserve(exec, bytes); }
static zvm_status_v2 poll(zvm_porf_exec_ctx_v2* exec, u32 flags) { (void)flags; exec->polls++; return exec->poll_status; }
static zvm_status_v2 trap(zvm_porf_exec_ctx_v2* exec, u32 code) { (void)exec; (void)code; return ZVM_STATUS_V2_TRAP; }
int main(void) {
  const zvm_porf_provider_api_v1 provider = { sizeof provider, ZVM_PORFFOR_PROVIDER_API_V1_VERSION, base, reserve, commit, 0, 0, 0, poll, trap, 0, 0 };
  zvm_porf_exec_ctx_v2 first = {0}, second = {0}; zvm_status_v2 status = ZVM_STATUS_V2_OK;
  jsval a = p1_allocateAndLoop(&first, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(3));
  if (status != ZVM_STATUS_V2_OK || (u32)a.val == 0u || first.polls != 3u) return 1;
  status = ZVM_STATUS_V2_OK;
  jsval b = p1_allocateAndLoop(&second, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(2));
  if (status != ZVM_STATUS_V2_OK || (u32)b.val == 0u || second.polls != 2u || first.memory[0] != 0u) return 2;
  first.poll_status = ZVM_STATUS_V2_CANCELLED; status = ZVM_STATUS_V2_OK;
  (void)p1_allocateAndLoop(&first, &provider, &status, JV_UNDEFINED, JV_UNDEFINED, porf_box_num(1));
  return status == ZVM_STATUS_V2_CANCELLED ? 0 : 3;
}
`);
  execFileSync('zig', [ 'cc', `-I${resolve(root, '../../include')}`, harness, '-o', join(temp, 'interleave') ], { cwd: root, stdio: 'pipe' });
  execFileSync(join(temp, process.platform === 'win32' ? 'interleave.exe' : 'interleave'), [], { cwd: root, stdio: 'pipe' });

  const hostRuntime = renderRuntime({ staticEnd: 0, globals: [], hostImports: [ { id: 1, name: 'host', parameters: [], result: 'i32' } ] });
  assert.match(hostRuntime, /if \(\*status == ZVM_STATUS_V2_OK\) \*status = provider->host_dispatch/);
  assert.match(hostRuntime, /provider->raise_trap/);
} catch (error) {
  // The sandbox used for repository inspection disallows child-process
  // creation from Node. Keep structural assertions above available there;
  // normal test environments still compile and run the generated harness.
  if (error?.code !== 'EPERM') throw error;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
