export function allocateAndLoop(limit: number): number {
  const staticLabel: bytestring = 'per-context';
  const value: pointer = Porffor.malloc(8);
  let total: number = value;
  if (staticLabel) total = value;
  for (let i = 0; i < limit; i++) total += i;
  return total;
}
