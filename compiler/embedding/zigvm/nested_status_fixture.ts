function inner(): number {
  throw 1;
}

export function nestedTrap(): number {
  const ignored = inner();
  return Porffor.malloc(8);
}

function recurse(remaining: number): number {
  if (remaining <= 0) return 0;
  return recurse(remaining - 1) + 1;
}

export function recursivePoll(remaining: number): number {
  return recurse(remaining);
}
