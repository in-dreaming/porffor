const { tick } = Porffor.dlopen("__zigvm_library__", {
  tick: { id: 5, parameters: ["i32"], result: "i32" }
});

export function run(value: number): number {
  return tick(value);
}
