import assert from 'node:assert/strict';
import parse from '../../parse.js';
import codegen from '../../codegen.js';
import render from '../../render.js';
import { lowerExplicitExec } from './lowering.js';

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
