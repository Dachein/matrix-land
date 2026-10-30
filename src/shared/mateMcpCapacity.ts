export const MATE_MCP_CAPACITY_CHILDREN = {
  ai_capacity: ["models", "web", "image", "video", "audio", "jev"],
  forum_hub: ["forum_read", "forum_write", "forum_media", "hub_discovery", "hub_skill"]
} as const;

/** Model catalog stays outside the Mate's individually selectable capacity list. */
export function mateMcpCapacityConfigurableChildren(group: MateMcpCapacityGroup): readonly string[] {
  return (MATE_MCP_CAPACITY_CHILDREN[group] as readonly string[])
    .filter((child) => !(group === "ai_capacity" && child === "models"));
}

export type MateMcpCapacityGroup = keyof typeof MATE_MCP_CAPACITY_CHILDREN;
export type MateMcpCapacitySelection =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "selected"; children: string[] };

export type MateMcpCapacity = Record<MateMcpCapacityGroup, MateMcpCapacitySelection>;

export const DEFAULT_MATE_MCP_CAPACITY: MateMcpCapacity = {
  ai_capacity: { mode: "all" },
  forum_hub: { mode: "all" }
};

export function mateCapacityIncludes(selection: MateMcpCapacitySelection | undefined, child: string) {
  return selection?.mode === "all" || (selection?.mode === "selected" && selection.children.includes(child));
}

/** Published legacy releases are immutable. Interpret their Forum bindings as MCP scope. */
export function mateForumMcpSelection(resources: {
  builtInToolBindings?: readonly { toolId: string }[];
  mcpCapacity?: MateMcpCapacity;
}): MateMcpCapacitySelection | undefined {
  if (resources.mcpCapacity) return resources.mcpCapacity.forum_hub;
  const bindings = resources.builtInToolBindings ?? [];
  const children = [
    ...(bindings.some((binding) => binding.toolId === "workspace_forum_read") ? ["forum_read"] : []),
    ...(bindings.some((binding) => binding.toolId === "workspace_forum_post") ? ["forum_write"] : [])
  ];
  return children.length ? { mode: "selected", children } : undefined;
}

/** Preserve an older draft's enabled capabilities when Builder first saves the new controls. */
export function migrateLegacyMateMcpCapacity(resources: {
  builtInToolBindings?: readonly { toolId: string }[];
  mcpCapacity?: MateMcpCapacity;
}): MateMcpCapacity {
  if (resources.mcpCapacity) return resources.mcpCapacity;
  const bindings = resources.builtInToolBindings ?? [];
  const aiChildren = [
    ...(bindings.some((binding) => binding.toolId === "public_web_read" || binding.toolId === "public_web_search") ? ["web"] : []),
    ...(bindings.some((binding) => binding.toolId === "artifact_create") ? ["image", "video", "audio"] : [])
  ];
  return {
    ai_capacity: aiChildren.length ? { mode: "selected", children: aiChildren } : { mode: "none" },
    forum_hub: mateForumMcpSelection(resources) ?? { mode: "none" }
  };
}

export function selectMateCapacityChildren(
  group: MateMcpCapacityGroup,
  selected: readonly string[]
): MateMcpCapacitySelection {
  const known = mateMcpCapacityConfigurableChildren(group);
  const children = [...new Set(selected)].filter((child) => known.includes(child));
  if (!children.length) return { mode: "none" };
  if (children.length === known.length) return { mode: "all" };
  return { mode: "selected", children };
}

export function isMateMcpCapacity(value: unknown): value is MateMcpCapacity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const groups = value as Record<string, unknown>;
  if (Object.keys(groups).some((key) => !(key in MATE_MCP_CAPACITY_CHILDREN))) return false;
  return (Object.keys(MATE_MCP_CAPACITY_CHILDREN) as MateMcpCapacityGroup[]).every((group) => {
    const selection = groups[group];
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) return false;
    const item = selection as Record<string, unknown>;
    if (item.mode === "all" || item.mode === "none") return Object.keys(item).length === 1;
    if (item.mode !== "selected" || !Array.isArray(item.children) || item.children.length === 0) return false;
    const children = item.children as unknown[];
    return Object.keys(item).length === 2
      && children.length < MATE_MCP_CAPACITY_CHILDREN[group].length
      && children.every((child) => typeof child === "string" && (MATE_MCP_CAPACITY_CHILDREN[group] as readonly string[]).includes(child))
      && new Set(children).size === children.length;
  });
}
