const { fail } = Porffor.dlopen('__zigvm_host__', {
  fail: { id: 1, parameters: [], result: 'i32' }
});

export function hostThenAllocate(): number {
  const ignored = fail();
  return Porffor.malloc(8);
}
