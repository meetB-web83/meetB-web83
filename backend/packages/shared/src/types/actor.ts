export const OPERATOR = 'operator';

export type Actor = string;

export function isOperator(actor: string): boolean {
  return actor === OPERATOR;
}
