const problemJson = {
  description: "RFC 9457 problem+json error",
  content: {
    "application/problem+json": {
      schema: {
        type: "object",
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
        },
        required: ["title", "status"],
      },
    },
  },
};

const issue = {
  type: "object",
  properties: {
    key: { type: "string", example: "KPT-42" },
    id: { type: "string" },
    title: { type: "string" },
    typeId: { type: "string" },
    statusId: { type: "string" },
    priority: { type: "string", enum: ["lowest", "low", "medium", "high", "highest"], nullable: true },
    assigneeId: { type: "string", nullable: true },
    reporterId: { type: "string" },
    storyPoints: { type: "number", nullable: true },
    dueDate: { type: "string", format: "date-time", nullable: true },
    labels: { type: "array", items: { type: "string" } },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const page = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    icon: { type: "string", nullable: true },
    parentPageId: { type: "string", nullable: true },
    projectId: { type: "string", nullable: true },
    type: { type: "string", enum: ["doc", "template"] },
    content: { type: "string", description: "Markdown, present only on GET /pages/{pageId}" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const comment = {
  type: "object",
  properties: {
    id: { type: "string" },
    authorId: { type: "string" },
    text: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
  },
};

const idempotencyKeyParam = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Dedupes retried creates. Same key + same endpoint replays the original response instead of creating a duplicate.",
  schema: { type: "string" },
};

export function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kompast API",
      version: "1",
      description:
        "REST API v1 for Kompast — issues, pages, and search. Every write is attributed (origin: \"api\") " +
        "and enforces the same permissions as the UI. Personal access tokens are managed at /tokens.",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "kmp_… personal access token",
          description:
            "Generate a token at /tokens. Scopes: issues:read, issues:write, pages:read, pages:write, sprints:write, admin. " +
            "A token can never exceed the granting user's own workspace permissions.",
        },
      },
      schemas: { issue, page, comment },
    },
    paths: {
      "/api/v1/issues": {
        get: {
          summary: "List issues in a project",
          parameters: [
            { name: "projectKey", in: "query", required: true, schema: { type: "string" } },
            { name: "cursor", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { data: { type: "array", items: issue }, nextCursor: { type: "integer", nullable: true } } },
                },
              },
            },
            "401": problemJson,
          },
        },
        post: {
          summary: "Create an issue",
          parameters: [idempotencyKeyParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["projectKey", "title"],
                  properties: {
                    projectKey: { type: "string" },
                    title: { type: "string" },
                    type: { type: "string", description: "Issue type name, e.g. \"Task\". Defaults to the project's default type." },
                    status: { type: "string", description: "Status name. Defaults to the project's initial status." },
                    priority: { type: "string", enum: ["lowest", "low", "medium", "high", "highest"] },
                    assigneeEmail: { type: "string", format: "email" },
                    description: { type: "string" },
                    labels: { type: "array", items: { type: "string" } },
                    storyPoints: { type: "number" },
                    dueDate: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { key: { type: "string" }, id: { type: "string" } } } } } },
            "400": problemJson,
            "401": problemJson,
            "403": problemJson,
          },
        },
      },
      "/api/v1/issues/{issueKey}": {
        parameters: [{ name: "issueKey", in: "path", required: true, schema: { type: "string" }, example: "KPT-42" }],
        get: {
          summary: "Get an issue",
          responses: { "200": { description: "OK", content: { "application/json": { schema: issue } } }, "401": problemJson, "404": problemJson },
        },
        patch: {
          summary: "Update an issue (partial)",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    priority: { type: "string", enum: ["lowest", "low", "medium", "high", "highest"] },
                    assigneeEmail: { type: "string", format: "email", nullable: true },
                    storyPoints: { type: "number", nullable: true },
                    dueDate: { type: "string", format: "date-time", nullable: true },
                    startDate: { type: "string", format: "date-time", nullable: true },
                    epicKey: { type: "string", nullable: true, description: "Key of an Epic-type issue in the same project, or null to unlink." },
                    labels: { type: "array", items: { type: "string" } },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "OK" }, "401": problemJson, "404": problemJson },
        },
      },
      "/api/v1/issues/{issueKey}/transition": {
        parameters: [{ name: "issueKey", in: "path", required: true, schema: { type: "string" } }],
        post: {
          summary: "Move an issue to a different status",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status"], properties: { status: { type: "string", example: "In Progress" } } } } } },
          responses: { "200": { description: "OK" }, "401": problemJson, "404": problemJson },
        },
      },
      "/api/v1/issues/{issueKey}/comments": {
        parameters: [{ name: "issueKey", in: "path", required: true, schema: { type: "string" } }],
        get: {
          summary: "List comments on an issue",
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: comment } } } } } } },
        },
        post: {
          summary: "Add a comment to an issue",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
          responses: { "201": { description: "Created" }, "401": problemJson, "404": problemJson },
        },
      },
      "/api/v1/pages": {
        get: {
          summary: "List pages",
          parameters: [{ name: "projectKey", in: "query", schema: { type: "string" }, description: "Omit to list workspace-level pages" }],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: page } } } } } } },
        },
        post: {
          summary: "Create a page",
          parameters: [idempotencyKeyParam],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title"],
                  properties: {
                    title: { type: "string" },
                    parentPageId: { type: "string", nullable: true },
                    projectKey: { type: "string" },
                    content: { type: "string", description: "Initial body as Markdown. Only honored on create — see PATCH." },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created", content: { "application/json": { schema: page } } }, "401": problemJson },
        },
      },
      "/api/v1/pages/{pageId}": {
        parameters: [{ name: "pageId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          summary: "Get a page, rendered as Markdown",
          responses: { "200": { description: "OK", content: { "application/json": { schema: page } } }, "401": problemJson, "404": problemJson },
        },
        patch: {
          summary: "Update a page's title/icon (content is not replaceable via REST — see docs)",
          description:
            "Deliberately metadata-only. Overwriting a page's Yjs document from outside the collab session would " +
            "race with any live editor connected to it, so full content replacement isn't offered here.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, icon: { type: "string", nullable: true } } } } } },
          responses: { "200": { description: "OK" }, "401": problemJson, "404": problemJson },
        },
      },
      "/api/v1/pages/{pageId}/comments": {
        parameters: [{ name: "pageId", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "List comments on a page", responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: comment } } } } } } } },
        post: {
          summary: "Add a comment to a page",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" }, blockId: { type: "string" } } } } } },
          responses: { "201": { description: "Created" }, "401": problemJson, "404": problemJson },
        },
      },
      "/api/v1/pages/{pageId}/links": {
        parameters: [{ name: "pageId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          summary: "List issues linked to/from a page",
          responses: {
            "200": {
              description: "OK",
              content: { "application/json": { schema: { type: "object", properties: { linkedIssueIds: { type: "array", items: { type: "string" } }, mentionedBy: { type: "array", items: { type: "string" } } } } } },
            },
          },
        },
        post: {
          summary: "Link a page to an issue",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["issueKey"], properties: { issueKey: { type: "string" } } } } } },
          responses: { "201": { description: "Created" }, "401": problemJson, "404": problemJson },
        },
        delete: {
          summary: "Unlink a page from an issue",
          parameters: [{ name: "issueKey", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "400": problemJson, "401": problemJson },
        },
      },
      "/api/v1/sprints": {
        get: {
          summary: "List sprints for a project's board",
          parameters: [{ name: "projectKey", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "400": problemJson, "401": problemJson },
        },
        post: {
          summary: "Create a sprint",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["projectKey", "name"],
                  properties: {
                    projectKey: { type: "string" },
                    name: { type: "string" },
                    goal: { type: "string" },
                    cycle: { type: "string", enum: ["1w", "2w", "3w", "4w", "custom"] },
                    startAt: { type: "string", format: "date-time" },
                    endAt: { type: "string", format: "date-time" },
                    capacityPoints: { type: "number" },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created" }, "401": problemJson, "403": problemJson },
        },
      },
      "/api/v1/sprints/{sprintId}": {
        parameters: [{ name: "sprintId", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "Get a sprint and its live scope/completion report", responses: { "200": { description: "OK" }, "401": problemJson, "404": problemJson } },
      },
      "/api/v1/sprints/{sprintId}/start": {
        parameters: [{ name: "sprintId", in: "path", required: true, schema: { type: "string" } }],
        post: {
          summary: "Start a sprint (fails if the board already has one active)",
          responses: { "200": { description: "OK" }, "401": problemJson, "403": problemJson, "404": problemJson },
        },
      },
      "/api/v1/sprints/{sprintId}/complete": {
        parameters: [{ name: "sprintId", in: "path", required: true, schema: { type: "string" } }],
        post: {
          summary: "Complete a sprint",
          description: "Not-done issues carry to carryToSprintId if given, else back to the backlog.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { carryToSprintId: { type: "string" } } } } } },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      completedIssueCount: { type: "integer" },
                      completedPoints: { type: "integer" },
                      carriedIssueCount: { type: "integer" },
                      carriedPoints: { type: "integer" },
                      velocity: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": problemJson,
            "403": problemJson,
            "404": problemJson,
          },
        },
      },
      "/api/v1/sprints/{sprintId}/issues": {
        parameters: [{ name: "sprintId", in: "path", required: true, schema: { type: "string" } }],
        get: { summary: "List issues currently on a sprint", responses: { "200": { description: "OK" }, "401": problemJson, "404": problemJson } },
        post: {
          summary: "Add an issue to a sprint",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["issueKey"], properties: { issueKey: { type: "string" } } } } } },
          responses: { "201": { description: "Created" }, "401": problemJson, "403": problemJson, "404": problemJson },
        },
        delete: {
          summary: "Remove an issue from a sprint (back to the backlog)",
          parameters: [{ name: "issueKey", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "400": problemJson, "401": problemJson },
        },
      },
      "/api/v1/sprints/{sprintId}/report": {
        parameters: [{ name: "sprintId", in: "path", required: true, schema: { type: "string" } }],
        get: {
          summary: "Burndown + cumulative flow for a sprint",
          description:
            "Reconstructed day-by-day from issue_history — there's no nightly snapshot cron, so status-as-of-day falls back to an " +
            "issue's current status when it has no recorded status change before that day.",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      burndown: { type: "array", items: { type: "object", properties: { date: { type: "string" }, scopePoints: { type: "integer" }, remainingPoints: { type: "integer" } } } },
                      cumulativeFlow: {
                        type: "array",
                        items: { type: "object", properties: { date: { type: "string" }, todo: { type: "integer" }, inProgress: { type: "integer" }, done: { type: "integer" } } },
                      },
                    },
                  },
                },
              },
            },
            "401": problemJson,
            "404": problemJson,
          },
        },
      },
      "/api/v1/velocity": {
        get: {
          summary: "Completed points from a project's last several closed sprints",
          parameters: [{ name: "projectKey", in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { data: { type: "array", items: { type: "object", properties: { sprintId: { type: "string" }, sprintName: { type: "string" }, completedPoints: { type: "integer" } } } } } },
                },
              },
            },
            "400": problemJson,
            "401": problemJson,
          },
        },
      },
      "/api/v1/roadmap": {
        get: {
          summary: "Epics in a project with their date range and child-issue completion",
          parameters: [{ name: "projectKey", in: "query", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string" },
                            title: { type: "string" },
                            startDate: { type: "string", format: "date-time", nullable: true },
                            dueDate: { type: "string", format: "date-time", nullable: true },
                            childCount: { type: "integer" },
                            doneCount: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": problemJson,
            "401": problemJson,
          },
        },
      },
      "/api/v1/search": {
        get: {
          summary: "Unified search across issues and workspace members",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", default: 8, maximum: 50 } },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      issues: { type: "array", items: { type: "object", properties: { id: { type: "string" }, projectKey: { type: "string" }, keySeq: { type: "integer" }, title: { type: "string" }, statusName: { type: "string" } } } },
                      people: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } } } },
                    },
                  },
                },
              },
            },
            "401": problemJson,
          },
        },
      },
    },
  } as const;
}
