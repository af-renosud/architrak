/** Pocket-calculator semantics: operations execute left to right, not algebraic precedence. */
export type CalculatorOperator = "+" | "-" | "*" | "/";
export type CalculatorAction =
  | { type: "digit"; digit: string }
  | { type: "operator"; operator: CalculatorOperator }
  | { type: "decimal" | "sign" | "percent" | "clear" | "backspace" | "equals" };

export interface CalculatorState {
  display: string;
  accumulator: number | null;
  operator: CalculatorOperator | null;
  replace: boolean;
  error: boolean;
}

export const initialCalculatorState: CalculatorState = {
  display: "0", accumulator: null, operator: null, replace: false, error: false,
};

function format(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(12))) : "Erreur";
}

function apply(left: number, right: number, operator: CalculatorOperator): number {
  switch (operator) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return right === 0 ? NaN : left / right;
  }
}

function withValue(state: CalculatorState, value: number): CalculatorState {
  const display = format(value);
  return display === "Erreur"
    ? { ...initialCalculatorState, display, error: true, replace: true }
    : { ...state, display };
}

export function calculatorReducer(state: CalculatorState, action: CalculatorAction): CalculatorState {
  if (action.type === "clear") return { ...initialCalculatorState };
  if (state.error) {
    if (action.type !== "digit" && action.type !== "decimal") return state;
    state = { ...initialCalculatorState };
  }
  const value = Number(state.display);
  switch (action.type) {
    case "digit": {
      if (!/^\d$/.test(action.digit)) return state;
      if (!state.replace && state.display.replace(/[-.]/g, "").length >= 12) return state;
      const display = state.replace || state.display === "0"
        ? action.digit : state.display === "-0" ? `-${action.digit}` : state.display + action.digit;
      return { ...state, display, replace: false };
    }
    case "decimal":
      if (state.replace) return { ...state, display: "0.", replace: false };
      return state.display.includes(".") ? state : { ...state, display: state.display + "." };
    case "sign":
      if (state.replace && state.operator) return { ...state, display: "-0", replace: false };
      return { ...state, display: state.display.startsWith("-") ? state.display.slice(1) : `-${state.display}`, replace: false };
    case "percent": {
      // 200 + 10% = 220; multiplication/division percentages are simple fractions.
      const percent = state.accumulator !== null && (state.operator === "+" || state.operator === "-")
        ? state.accumulator * value / 100 : value / 100;
      return withValue({ ...state, replace: false }, percent);
    }
    case "backspace": {
      if (state.replace) return state;
      const display = state.display.slice(0, -1);
      return { ...state, display: !display || display === "-" ? "0" : display };
    }
    case "operator": {
      if (state.operator && state.replace) return { ...state, operator: action.operator };
      const next = state.operator && state.accumulator !== null
        ? withValue(state, apply(state.accumulator, value, state.operator)) : state;
      if (next.error) return next;
      return { ...next, accumulator: Number(next.display), operator: action.operator, replace: true };
    }
    case "equals":
      if (state.operator === null || state.accumulator === null) return state;
      return withValue({ ...state, accumulator: null, operator: null, replace: true },
        apply(state.accumulator, value, state.operator));
  }
}

export function calculatorActionForKey(key: string): CalculatorAction | null {
  if (/^\d$/.test(key)) return { type: "digit", digit: key };
  if (key === "." || key === ",") return { type: "decimal" };
  if (key === "+" || key === "-" || key === "*" || key === "/") return { type: "operator", operator: key };
  if (key === "Enter" || key === "=") return { type: "equals" };
  if (key === "Backspace") return { type: "backspace" };
  if (key === "Delete" || key.toLowerCase() === "c") return { type: "clear" };
  if (key === "%") return { type: "percent" };
  if (key === "F9") return { type: "sign" };
  return null;
}
