import { customAlphabet } from "nanoid";

// Base-62, no ambiguous-looking separators needed since these are never
// hand-typed — used for every domain table's text primary key.
const generate = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  20,
);

export function id(prefix: string): string {
  return `${prefix}_${generate()}`;
}
