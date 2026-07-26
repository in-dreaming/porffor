const { tick } = Porffor.dlopen("__zigvm_library__", {
  tick: { id: 5, parameters: ["i32"], result: "void" }
});

export function run(value: number): number {
  tick(value);
  return value;
}
