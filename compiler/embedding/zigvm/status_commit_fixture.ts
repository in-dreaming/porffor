const { fail } = Porffor.dlopen('__zigvm_host__', {
  fail: { id: 1, parameters: [], result: 'i32' }
});

let shared: number = 41;

export function globalAssignment(): number {
  shared = fail();
  return shared;
}
