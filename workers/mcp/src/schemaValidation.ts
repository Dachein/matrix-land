export type SchemaValidationIssue = {
  instancePath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
};

type JsonSchema = Record<string, unknown>;

export function validateJsonSchema(schema: JsonSchema, value: unknown) {
  const issues: SchemaValidationIssue[] = [];
  validateValue(schema, value, "", issues);
  return issues;
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  if (Object.hasOwn(schema, "const") && !sameJsonValue(value, schema.const)) {
    addIssue(issues, instancePath, "const", "must equal the allowed constant", { allowedValue: schema.const });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameJsonValue(value, entry))) {
    addIssue(issues, instancePath, "enum", "must be one of the allowed values", { allowedValues: schema.enum });
  }

  const type = typeof schema.type === "string" ? schema.type : "";
  if (type && !matchesType(type, value)) {
    addIssue(issues, instancePath, "type", `must be ${type}`, { type });
    return;
  }

  validateCompositions(schema, value, instancePath, issues);

  if (typeof value === "string") validateString(schema, value, instancePath, issues);
  if (typeof value === "number") validateNumber(schema, value, instancePath, issues);
  if (Array.isArray(value)) validateArray(schema, value, instancePath, issues);
  if (isRecord(value)) validateObject(schema, value, instancePath, issues);
}

function validateCompositions(
  schema: JsonSchema,
  value: unknown,
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  const allOf = schemaArray(schema.allOf);
  for (const branch of allOf) validateValue(branch, value, instancePath, issues);

  const anyOf = schemaArray(schema.anyOf);
  if (anyOf.length > 0 && !anyOf.some((branch) => branchMatches(branch, value, instancePath))) {
    addIssue(issues, instancePath, "anyOf", "must satisfy at least one allowed argument shape", {});
  }

  const oneOf = schemaArray(schema.oneOf);
  if (oneOf.length > 0) {
    const matches = oneOf.filter((branch) => branchMatches(branch, value, instancePath)).length;
    if (matches !== 1) {
      addIssue(issues, instancePath, "oneOf", "must satisfy exactly one allowed argument shape", { matches });
    }
  }
}

function validateObject(
  schema: JsonSchema,
  value: Record<string, unknown>,
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  const required = stringArray(schema.required);
  for (const name of required) {
    if (!Object.hasOwn(value, name)) {
      addIssue(issues, instancePath, "required", `must include ${name}`, { missingProperty: name });
    }
  }

  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, propertyValue] of Object.entries(value)) {
    const propertyPath = `${instancePath}/${escapeJsonPointer(name)}`;
    const propertySchema = properties[name];
    if (isRecord(propertySchema)) {
      validateValue(propertySchema, propertyValue, propertyPath, issues);
      continue;
    }

    if (schema.additionalProperties === false) {
      addIssue(issues, instancePath, "additionalProperties", `does not support ${name}`, {
        additionalProperty: name
      });
    } else if (isRecord(schema.additionalProperties)) {
      validateValue(schema.additionalProperties, propertyValue, propertyPath, issues);
    }
  }

  const size = Object.keys(value).length;
  compareCount(schema, "minProperties", size, instancePath, issues);
  compareCount(schema, "maxProperties", size, instancePath, issues);
}

function validateArray(
  schema: JsonSchema,
  value: unknown[],
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  compareCount(schema, "minItems", value.length, instancePath, issues);
  compareCount(schema, "maxItems", value.length, instancePath, issues);
  if (schema.uniqueItems === true) {
    const serialized = value.map((entry) => JSON.stringify(entry));
    if (new Set(serialized).size !== serialized.length) {
      addIssue(issues, instancePath, "uniqueItems", "must not contain duplicate items", {});
    }
  }
  if (isRecord(schema.items)) {
    value.forEach((entry, index) => validateValue(schema.items as JsonSchema, entry, `${instancePath}/${index}`, issues));
  }
}

function validateString(
  schema: JsonSchema,
  value: string,
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  compareCount(schema, "minLength", [...value].length, instancePath, issues);
  compareCount(schema, "maxLength", [...value].length, instancePath, issues);
  if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    addIssue(issues, instancePath, "pattern", "must match the required pattern", { pattern: schema.pattern });
  }
}

function validateNumber(
  schema: JsonSchema,
  value: number,
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    addIssue(issues, instancePath, "minimum", `must be at least ${schema.minimum}`, { limit: schema.minimum });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    addIssue(issues, instancePath, "maximum", `must be at most ${schema.maximum}`, { limit: schema.maximum });
  }
}

function compareCount(
  schema: JsonSchema,
  keyword: "minItems" | "maxItems" | "minLength" | "maxLength" | "minProperties" | "maxProperties",
  actual: number,
  instancePath: string,
  issues: SchemaValidationIssue[]
) {
  const limit = schema[keyword];
  if (typeof limit !== "number") return;
  const isMinimum = keyword.startsWith("min");
  if (isMinimum ? actual < limit : actual > limit) {
    addIssue(
      issues,
      instancePath,
      keyword,
      `must have ${isMinimum ? "at least" : "at most"} ${limit} ${keyword.includes("Length") ? "characters" : "items"}`,
      { limit }
    );
  }
}

function branchMatches(schema: JsonSchema, value: unknown, instancePath: string) {
  const branchIssues: SchemaValidationIssue[] = [];
  validateValue(schema, value, instancePath, branchIssues);
  return branchIssues.length === 0;
}

function matchesType(type: string, value: unknown) {
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function schemaArray(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function addIssue(
  issues: SchemaValidationIssue[],
  instancePath: string,
  keyword: string,
  message: string,
  params: Record<string, unknown>
) {
  issues.push({ instancePath, keyword, message, params });
}

function escapeJsonPointer(value: string) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function sameJsonValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
