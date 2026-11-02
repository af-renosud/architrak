import { describe, expect, it } from "vitest";
import { calculatorActionForKey, calculatorReducer, initialCalculatorState, type CalculatorState } from "../calculator";

function calculate(keys: string[], state: CalculatorState = initialCalculatorState) {
  return keys.reduce((current, key) => {
    const action = calculatorActionForKey(key);
    if (!action) throw new Error(`Unsupported key: ${key}`);
    return calculatorReducer(current, action);
  }, state);
}

describe("calculator", () => {
  it.each([
    [["1", "2", "+", "3", "Enter"], "15"],
    [["9", "-", "4", "="], "5"],
    [["6", "*", "7", "="], "42"],
    [["8", "/", "2", "="], "4"],
    [["0", ".", "1", "+", "0", ",", "2", "="], "0.3"],
    [["2", "+", "3", "*", "4", "="], "20"],
    [["2", "+", "*", "3", "="], "6"],
    [["5", "F9", "*", "2", "="], "-10"],
    [["5", "F9", "F9"], "5"],
    [["5", "+", "F9", "2", "="], "3"],
    [["5", "0", "%"], "0.5"],
    [["2", "0", "0", "+", "1", "0", "%", "="], "220"],
    [["2", "0", "0", "-", "1", "0", "%", "="], "180"],
    [["2", "0", "0", "*", "1", "0", "%", "="], "20"],
    [["1", "2", "Backspace"], "1"],
    [["1", "Backspace", "Backspace"], "0"],
    [["1", "F9", "Backspace"], "0"],
    [["1", ".", ".", "2"], "1.2"],
    [["0", "0", "2"], "2"],
    [["2", "+", "3", "=", "7"], "7"],
    [["2", "+", "3", "=", "+", "4", "="], "9"],
    [["2", "+", "3", "=", "=", "="], "5"],
    [["2", "+", "3", "=", ".", "5"], "0.5"],
    [["2", "+", "C", "3"], "3"],
  ])("handles %j", (keys, display) => {
    expect(calculate(keys).display).toBe(display);
  });

  it("handles division by zero and allows recovery", () => {
    const error = calculate(["8", "/", "0", "="]);
    expect(error.error).toBe(true);
    expect(error.display).toBe("Erreur");
    expect(calculate(["+"], error)).toEqual(error);
    expect(calculate(["2"], error).display).toBe("2");
    expect(calculate(["."], error).display).toBe("0.");
    expect(calculate(["C"], error)).toEqual(initialCalculatorState);
  });

  it("limits input precision and refuses invalid digits", () => {
    expect(calculate("123456789012345".split("")).display).toBe("123456789012");
    expect(calculatorReducer(initialCalculatorState, { type: "digit", digit: "12" })).toEqual(initialCalculatorState);
  });

  it("keeps the original state immutable", () => {
    calculate(["8", "+", "4", "="]);
    expect(initialCalculatorState).toEqual({
      display: "0", accumulator: null, operator: null, replace: false, error: false,
    });
  });

  it("only maps calculator keys, leaving Escape, Tab and Space to the dialog", () => {
    for (const key of ["Escape", "Tab", " ", "a"]) expect(calculatorActionForKey(key)).toBeNull();
    expect(calculatorActionForKey("Delete")).toEqual({ type: "clear" });
  });
});
