function inner(): number {
  throw 1;
}

export function nestedTrap(): number {
  const ignored = inner();
  return Porffor.malloc(8);
}
