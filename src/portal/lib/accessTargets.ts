export type AccessTargetUser = {
  avatarUrl?: string;
  department?: string;
  departmentId?: string;
  departmentPath?: string[];
  email: string;
  id: string;
  name?: string;
  team?: string;
};

export type AccessTargetDepartment = {
  id: string;
  name: string;
  parentId?: string;
  path?: string[];
  status?: "active" | "inactive";
};

export type AccessTargetTreeNode = {
  children: AccessTargetTreeNode[];
  id: string;
  label: string;
  pathLabel: string;
  searchText: string;
  users: AccessTargetUser[];
  value: string;
};

export type AccessTargetInfo = {
  detail?: string;
  label: string;
  type: "department" | "user";
  value: string;
};

export type AccessTargetLookup = {
  departments: Map<string, AccessTargetInfo>;
  users: Map<string, AccessTargetInfo>;
};

export function buildAccessTargetTree(users: AccessTargetUser[], rootLabel = "Organization", departments?: AccessTargetDepartment[]) {
  const root: AccessTargetTreeNode = {
    id: "root",
    label: rootLabel,
    pathLabel: rootLabel,
    searchText: rootLabel.toLowerCase(),
    value: "",
    children: [],
    users: []
  };
  if (departments !== undefined) {
    const nodeById = new Map<string, AccessTargetTreeNode>();
    const departmentById = new Map(departments.filter((department) => department.status !== "inactive")
      .map((department) => [department.id, department]));
    for (const department of departmentById.values()) {
      nodeById.set(department.id, {
        id: department.id, label: department.name, pathLabel: department.name,
        searchText: "", value: departmentTargetValue(department.id), children: [], users: []
      });
    }
    for (const department of departmentById.values()) {
      const node = nodeById.get(department.id)!;
      const ancestors: string[] = [];
      const seen = new Set([department.id]);
      let parentId = department.parentId;
      while (parentId && departmentById.has(parentId) && !seen.has(parentId)) {
        seen.add(parentId);
        ancestors.unshift(parentId);
        parentId = departmentById.get(parentId)?.parentId;
      }
      // A malformed cycle remains browsable without creating recursive nodes.
      const cyclic = Boolean(parentId && seen.has(parentId));
      node.pathLabel = [...(cyclic ? [] : ancestors).map((id) => departmentById.get(id)!.name), department.name].join(" / ");
      node.searchText = `${node.pathLabel} ${department.id}`.toLowerCase();
      const parent = !cyclic && department.parentId ? nodeById.get(department.parentId) : undefined;
      (parent ?? root).children.push(node);
    }
    for (const user of users) {
      const departmentId = user.departmentId || user.departmentPath?.at(-1);
      (departmentId && nodeById.get(departmentId) || root).users.push(user);
    }
    sortAccessTargetTree(root);
    return root;
  }
  const nodeByKey = new Map<string, AccessTargetTreeNode>();

  users.forEach((user) => {
    const parts = organizationPathParts(user);
    const idPath = Array.isArray(user.departmentPath) ? user.departmentPath.filter(Boolean) : [];
    // A leaf display name cannot label the first ID of a complete ancestry.
    const aligned = parts.length === idPath.length;
    const labelParts = idPath.length && !aligned ? [parts.at(-1)!] : parts;
    const nodeIds = aligned ? idPath : [user.departmentId || idPath.at(-1)].filter(Boolean);
    let parent = root;
    const labelPath: string[] = [];

    labelParts.forEach((part, index) => {
      labelPath.push(part);
      const pathLabel = labelPath.join(" / ");
      const fallbackPathKey = labelPath.join("/");
      const nodeId = nodeIds[index] || (index === labelParts.length - 1 ? user.departmentId : undefined) || fallbackPathKey;
      const nodeKey = nodeIds.length > index ? nodeIds.slice(0, index + 1).join("/") : fallbackPathKey;
      let node = nodeByKey.get(nodeKey);

      if (!node) {
        node = {
          id: nodeKey,
          label: part,
          pathLabel,
          searchText: `${part} ${pathLabel} ${nodeId}`.toLowerCase(),
          value: departmentTargetValue(nodeId),
          children: [],
          users: []
        };
        nodeByKey.set(nodeKey, node);
        parent.children.push(node);
      }

      parent = node;
    });

    parent.users.push(user);
  });

  sortAccessTargetTree(root);
  return root;
}

export function buildAccessTargetLookup(users: AccessTargetUser[], departmentDirectory?: AccessTargetDepartment[]): AccessTargetLookup {
  const departments = new Map<string, AccessTargetInfo>();
  const userTargets = new Map<string, AccessTargetInfo>();
  const root = buildAccessTargetTree(users, "Organization", departmentDirectory);

  flattenDepartmentNodes(root.children).forEach((node) => {
    departments.set(node.value, {
      detail: node.value.slice("department:".length),
      label: node.pathLabel,
      type: "department",
      value: node.value
    });
  });

  users.forEach((user) => {
    const label = user.name || user.email || user.id;
    const detail = user.email || user.id;
    const info: AccessTargetInfo = {
      detail,
      label,
      type: "user",
      value: userTargetValue(user.id)
    };

    userTargets.set(userTargetValue(user.id), info);
  });

  return { departments, users: userTargets };
}

export function resolveAccessTargetInfo(value: string, lookup: AccessTargetLookup): AccessTargetInfo | undefined {
  if (value.startsWith("department:")) {
    const target = value.slice("department:".length);

    return lookup.departments.get(value) ?? {
      detail: target,
      label: target,
      type: "department",
      value
    };
  }

  if (value.startsWith("user:")) {
    const target = value.slice("user:".length);

    return lookup.users.get(value) ?? {
      detail: target,
      label: target,
      type: "user",
      value
    };
  }
  return undefined;
}

export function departmentTargetValue(departmentId: string) {
  return `department:${departmentId}`;
}

export function userTargetValue(userId: string) {
  return `user:${userId}`;
}

export function organizationPathParts(user: Pick<AccessTargetUser, "department" | "team">) {
  const raw = user.department || "Unassigned";
  return raw.split(/[/>]/).map((part) => part.trim()).filter(Boolean);
}

function sortAccessTargetTree(node: AccessTargetTreeNode) {
  node.children.sort((left, right) => left.label.localeCompare(right.label));
  node.users.sort((left, right) => (left.name || left.email).localeCompare(right.name || right.email));
  node.children.forEach(sortAccessTargetTree);
}

function flattenDepartmentNodes(nodes: AccessTargetTreeNode[]): AccessTargetTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenDepartmentNodes(node.children)]);
}
