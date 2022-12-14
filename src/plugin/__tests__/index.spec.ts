const { transform } = require("@babel/core");
const prettier = require("prettier");

const conf = {
  filename: "test.js",
  plugins: ["./src/plugin/index.js"],
};

describe("babel-plugin-preserve-jscontext-function-to-string", () => {
  it("should not decorate function when worklet key is not set in function", () => {
    const code = `var desc = { functions: {run: function run() {}}};
    test(desc);`;
    const [, input, output] = transformCode(code, code);
    expect(output).toEqual(input);
  });

  it("should redeclare code when worklet key is set in function", () => {
    const f = runPluginAndEval('function run() {"worklet"; return 1000;}');
    expect(f._closure).toEqual({});
    expect(f.asString).toEqual("function run(){return 1000;}");
    expect(f.__location).toContain("test.js (1:0)");
  });

  it("should work with typescript types", () => {
    const output = runPluginAndEval(
      `function run(a:number):number {
        "worklet";
        return a*2; 
      }`
    );
    expect(output.asString).toEqual("function run(a){return a*2;}");
  });

  it("should not remove this keyword", () => {
    const [, output] = transformCode(
      `var desc = { 
        functions: {
          run: function run() {"worklet"; this.stop();},
          stop: function stop () {"worklet";}
        }
      };`
    );
    expect(output).toContain(`_run.asString = "function run(){this.stop();}"`);
  });

  it("should redeclare code with dependencies", () => {
    const output = runPluginAndEval(
      `var abba = 100;
      var z = {value: 100};
      function run() {
        "worklet";
        const b = 1000;
        return abba+b+z.value;
      }`
    );
    expect(output._closure).toEqual({ abba: 100, z: { value: 100 } });
  });

  it("should not add function Infinity as a dependecy", () => {
    const output = runPluginAndEval(
      `function run(a) {
        "worklet";
        return a === Infinity ? 1 : 0; 
      }`
    );
    expect(output._closure).toEqual({});
  });

  it("should not add function isNaN as a dependecy", () => {
    const output = runPluginAndEval(
      `function run(a) {
        "worklet";
        return isNaN(a) ? 1 : 0; 
      }`
    );
    expect(output._closure).toEqual({});
  });

  it("should support null coalescing operator", () => {
    const output = runPluginAndEval(
      `function run(a?:number) {
        "worklet";
        return a ?? 0; 
      }`
    );
    expect(output.asString).toEqual("function run(a){return a!=null?a:0;}");
  });

  it("#11: should add a variable used as a computed property to the dependencies object", () => {
    const output = runPluginAndEval(
      `const value = 'a';
      const run = () => {
        'worklet';    
        const someObj = {};
        someObj[value] = 1;
      };`
    );
    expect(output._closure).toEqual({ value: "a" });
  });
});

function formatCode(code: string): string {
  return prettier.format(code, { semi: false, parser: "babel" });
}

function runPluginAndEval(input: string) {
  // eslint-disable-next-line no-eval
  eval(runPlugin(input));
  // eslint-disable-next-line no-eval
  return eval("run");
}

function runPlugin(input: string): string {
  const inputFormatted = formatCode(input);
  const { code } = transform(inputFormatted, conf);
  return code;
}

function transformCode(input: string, expected?: string) {
  const inputFormatted = formatCode(input);

  const { code } = transform(inputFormatted, conf);
  const codeFormatted = formatCode(code);

  const expectedFormatted = expected ? formatCode(expected) : "";

  return [inputFormatted, codeFormatted, expectedFormatted];
}
