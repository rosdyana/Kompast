/**
 * Caller-facing lookup and input errors thrown from packages/core. Transport
 * adapters map them to HTTP / tool-error responses by class (apps/web's
 * handleApiRoute and the MCP tool wrapper): NotFoundError → 404,
 * ConflictError → 409, InvalidInputError → 400. Kept here rather than in
 * apps/web so the shared resolvers and the Ask Kompast tools can throw them
 * without depending on any HTTP type.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
