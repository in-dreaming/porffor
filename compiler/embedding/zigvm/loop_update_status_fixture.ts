const { fail } = Porffor.dlopen('__zigvm_host__', {
  fail: { id: 1, parameters: [], result: 'i32' }
});

let shared: number = 41;

export function forUpdateAssignment(): number {
  for (let i = 0; i < 1; shared = fail()) {}
  return shared;
}

export function continueUpdate(): number {
  let total = 0;
  for (let i = 0; i < 2; i = i + 1) {
    if (i === 0) continue;
    total += i;
  }
  return total;
}
