import { RuntimeHttpError } from "./types.ts";

/** Messages requires a plain object root. The SDK/MCP retains the original validator. */
export function plainObjectToolSchema(schema: Record<string, any>, errorCode: string): Record<string, any> {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(alternatives) || alternatives.length === 0) return schema;
  if ((schema.type !== undefined && schema.type !== "object") || !alternatives.every((branch: any) =>
    branch && typeof branch === "object" && !Array.isArray(branch)
    && (branch.type === "object" || (branch.type === undefined && schema.type === "object")))) {
    throw new RuntimeHttpError(502, errorCode);
  }
  const { oneOf: _oneOf, anyOf: _anyOf, ...root } = schema;
  const properties: Record<string, any> = { ...schema.properties };
  const propertyNames = new Set(alternatives.flatMap((branch: any) => Object.keys(branch.properties ?? {})));
  for (const name of propertyNames) {
    const variants = [...new Map(alternatives.filter((branch: any) => branch.properties?.[name])
      .map((branch: any) => [JSON.stringify(branch.properties[name]), branch.properties[name]])).values()];
    const merged = variants.length === 1 ? variants[0] : { anyOf: variants };
    properties[name] = properties[name] ? { allOf: [properties[name], merged] } : merged;
  }
  // Conditional required fields stay enforced by the unchanged local schema.
  const required = [...new Set<string>([
    ...(schema.required ?? []),
    ...(alternatives[0].required ?? []).filter((name: string) => alternatives.every((branch: any) => branch.required?.includes(name)))
  ])];
  const variants = alternatives.map((branch: any) => {
    const action = branch.properties?.action;
    return `${action ? `action=${JSON.stringify(action.const ?? action.enum)}` : "variant"}: required ${(branch.required ?? []).join(", ") || "none"}`;
  }).join("; ");
  return { ...root, type: "object", properties, ...(required.length ? { required } : {}),
    ...(alternatives.every((branch: any) => branch.additionalProperties === false) ? { additionalProperties: false } : {}),
    description: [schema.description, `Parameter variants (validated before execution): ${variants}`].filter(Boolean).join("\n") };
}
