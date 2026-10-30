import { Building2, Check, ChevronRight, Search, UsersRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { buildAccessTargetTree, userTargetValue, type AccessTargetDepartment, type AccessTargetTreeNode, type AccessTargetUser } from "../lib/accessTargets";

export type AccessTargetPickerNode = {
  children?: AccessTargetPickerNode[];
  detail?: string;
  label: string;
  searchText?: string;
  tagDetail?: string;
  type: "department" | "user";
  value: string;
};

export type AccessTargetPickerCopy = {
  collapseNodeLabel: (label: string) => string;
  expandNodeLabel: (label: string) => string;
  noResults: string;
  loadingLabel?: string;
  unavailableLabel?: string;
  removeTargetLabel: (label: string) => string;
  requiredLabel?: string;
  searchPlaceholder: string;
  selectedCountLabel: string;
  selectedObjectsLabel: string;
  title: string;
  validationHint?: string;
};

export function AccessTargetPicker({
  className = "",
  copy,
  nodes,
  onSelectionChange,
  selectedValues,
  state = "ready"
}: {
  className?: string;
  copy: AccessTargetPickerCopy;
  nodes: AccessTargetPickerNode[];
  onSelectionChange: (values: string[]) => void;
  selectedValues: string[];
  state?: "loading" | "ready" | "error";
}) {
  const [query, setQuery] = useState("");
  const [expandedValues, setExpandedValues] = useState<Set<string>>(() => new Set());
  const filteredNodes = useMemo(() => filterAccessTargetNodes(nodes, query), [nodes, query]);
  const selected = useMemo(() => new Set(selectedValues), [selectedValues]);
  const isSearching = query.trim().length > 0;

  function toggle(value: string) {
    const next = new Set(selectedValues);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    onSelectionChange([...next]);
  }

  function toggleExpanded(value: string) {
    setExpandedValues((current) => {
      const next = new Set(current);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  }

  return (
    <div className={`accessTargetPicker ${className}`.trim()}>
      <div className="accessTargetPickerHeader">
        <div>
          <strong>{copy.title}</strong>
          <small>{selectedValues.length > 0 ? copy.selectedCountLabel : copy.requiredLabel}</small>
        </div>
      </div>

      <label className="searchControl accessTargetPickerSearch">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} />
      </label>

      <div className="accessTargetPickerTree">
        {state !== "ready" ? (
          <div className={state === "error" ? "formMessage error" : "formMessage"} role={state === "error" ? "alert" : "status"}>
            {state === "error" ? copy.unavailableLabel : copy.loadingLabel}
          </div>
        ) : filteredNodes.length > 0 ? (
          filteredNodes.map((node) => (
            <AccessTargetPickerBranch
              copy={copy}
              expandedValues={expandedValues}
              forceOpen={isSearching}
              key={node.value}
              node={node}
              onExpandToggle={toggleExpanded}
              onToggle={toggle}
              selected={selected}
            />
          ))
        ) : (
          <div className="emptyState compact">{copy.noResults}</div>
        )}
      </div>

      {selectedValues.length === 0 && copy.validationHint && (
        <small className="accessTargetPickerHint">{copy.validationHint}</small>
      )}
    </div>
  );
}

export function AccessTargetSelectedTags({
  className = "",
  copy,
  emptyLabel,
  nodes,
  onRemove,
  readOnly = false,
  selectedValues
}: {
  className?: string;
  copy: Pick<AccessTargetPickerCopy, "removeTargetLabel" | "selectedObjectsLabel">;
  emptyLabel?: string;
  nodes: AccessTargetPickerNode[];
  onRemove?: (value: string) => void;
  readOnly?: boolean;
  selectedValues: string[];
}) {
  const selectedTargets = useMemo(() => selectedAccessTargets(nodes, selectedValues), [nodes, selectedValues]);

  if (selectedTargets.length === 0) {
    return emptyLabel ? <div className={`accessTargetSelectedTags empty ${className}`.trim()}>{emptyLabel}</div> : null;
  }

  return (
    <div aria-label={copy.selectedObjectsLabel} className={`accessTargetSelectedTags ${className}`.trim()}>
      {selectedTargets.map((target) => {
        const content = (
          <>
            <TargetIcon type={target.type} />
            <span>{target.label}</span>
            <small>{target.tagDetail ?? target.detail}</small>
            {!readOnly && <X size={12} />}
          </>
        );

        return readOnly ? (
          <span className={`accessTargetSelectedTag ${target.type} readonly`} key={target.value}>
            {content}
          </span>
        ) : (
          <button className={`accessTargetSelectedTag ${target.type}`} key={target.value} onClick={() => onRemove?.(target.value)} title={copy.removeTargetLabel(target.label)} type="button">
            {content}
          </button>
        );
      })}
    </div>
  );
}

export function accessTargetPickerNodesFromUsers({
  departments,
  departmentDetail,
  rootLabel,
  unassignedDepartment,
  users
}: {
  departments?: AccessTargetDepartment[];
  departmentDetail: string;
  rootLabel?: string;
  unassignedDepartment: string;
  users: AccessTargetUser[];
}) {
  const tree = buildAccessTargetTree(users, rootLabel ?? "Organization", departments);
  return [
    ...tree.users.map((user): AccessTargetPickerNode => ({
      detail: user.email, label: user.name || user.email,
      searchText: `${user.name || ""} ${user.email}`, tagDetail: unassignedDepartment,
      type: "user", value: userTargetValue(user.id)
    })),
    ...tree.children.map((node) => accessTargetPickerNodeFromDepartment(node, departmentDetail, unassignedDepartment))
  ];
}

export function selectedAccessTargets(nodes: AccessTargetPickerNode[], selectedValues: string[]) {
  const nodeByValue = new Map(flattenAccessTargetNodes(nodes).map((node) => [node.value, node]));

  return selectedValues.map((value) => nodeByValue.get(value) ?? fallbackAccessTargetNode(value));
}

export function filterAccessTargetNodes(nodes: AccessTargetPickerNode[], query: string): AccessTargetPickerNode[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return nodes;
  }

  return nodes.reduce<AccessTargetPickerNode[]>((filtered, node) => {
    const children = filterAccessTargetNodes(node.children ?? [], normalizedQuery);

    if (accessTargetNodeMatches(node, normalizedQuery) || children.length > 0) {
      filtered.push({ ...node, children });
    }

    return filtered;
  }, []);
}

function AccessTargetPickerBranch({
  copy,
  expandedValues,
  forceOpen,
  node,
  onExpandToggle,
  onToggle,
  selected
}: {
  copy: AccessTargetPickerCopy;
  expandedValues: Set<string>;
  forceOpen: boolean;
  node: AccessTargetPickerNode;
  onExpandToggle: (value: string) => void;
  onToggle: (value: string) => void;
  selected: Set<string>;
}) {
  const checked = selected.has(node.value);
  const children = node.children ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = forceOpen || expandedValues.has(node.value);

  return (
    <div className={`accessTargetPickerNode ${node.type}`}>
      <div className={checked ? "accessTargetPickerLine active" : "accessTargetPickerLine"}>
        {hasChildren ? (
          <button
            aria-label={isExpanded ? copy.collapseNodeLabel(node.label) : copy.expandNodeLabel(node.label)}
            className="accessTargetPickerExpandButton"
            onClick={() => onExpandToggle(node.value)}
            type="button"
          >
            <ChevronRight className={isExpanded ? "open" : ""} size={14} />
          </button>
        ) : (
          <span className="accessTargetPickerExpandSpacer" />
        )}
        <label className="accessTargetPickerSelect">
          <input checked={checked} onChange={() => onToggle(node.value)} type="checkbox" />
          <span className="accessTargetPickerCheck">
            <Check size={13} />
          </span>
          <TargetIcon type={node.type} />
          <span className="accessTargetPickerText">
            <strong>{node.label}</strong>
            {node.detail && <small>{node.detail}</small>}
          </span>
        </label>
      </div>
      {hasChildren && isExpanded && (
        <div className="accessTargetPickerChildren">
          {children.map((child) => (
            <AccessTargetPickerBranch
              copy={copy}
              expandedValues={expandedValues}
              forceOpen={forceOpen}
              key={child.value}
              node={child}
              onExpandToggle={onExpandToggle}
              onToggle={onToggle}
              selected={selected}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TargetIcon({ type }: { type: AccessTargetPickerNode["type"] }) {
  const Icon = type === "department" ? Building2 : UsersRound;
  return <Icon aria-hidden="true" className="accessTargetPickerTypeIcon" size={15} />;
}

function accessTargetPickerNodeFromDepartment(node: AccessTargetTreeNode, departmentDetail: string, unassignedDepartment: string): AccessTargetPickerNode {
  return {
    children: [
      ...node.users.map((user) => ({
        detail: user.email,
        label: user.name || user.email,
        searchText: `${user.name || ""} ${user.email || ""} ${node.pathLabel}`.trim(),
        tagDetail: leafDepartmentLabel(node.pathLabel, unassignedDepartment),
        type: "user" as const,
        value: userTargetValue(user.id)
      })),
      ...node.children.map((child) => accessTargetPickerNodeFromDepartment(child, departmentDetail, unassignedDepartment))
    ],
    detail: departmentDetail,
    label: node.label,
    tagDetail: node.pathLabel,
    searchText: node.searchText,
    type: "department",
    value: node.value
  };
}

function flattenAccessTargetNodes(nodes: AccessTargetPickerNode[]): AccessTargetPickerNode[] {
  return nodes.flatMap((node) => [node, ...flattenAccessTargetNodes(node.children ?? [])]);
}

function fallbackAccessTargetNode(value: string): AccessTargetPickerNode {
  if (value.startsWith("department:")) {
    const departmentId = value.slice("department:".length);
    return {
      detail: departmentId,
      label: departmentId,
      type: "department",
      value
    };
  }

  if (value.startsWith("user:")) {
    const userId = value.slice("user:".length);
    return {
      detail: userId,
      label: userId,
      type: "user",
      value
    };
  }

  return {
    detail: value,
    label: value,
    type: "user",
    value
  };
}

function leafDepartmentLabel(pathLabel: string, unassignedDepartment: string) {
  const parts = pathLabel.split(" / ").map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || unassignedDepartment;
}

function accessTargetNodeMatches(node: AccessTargetPickerNode, query: string) {
  return [node.label, node.detail, node.searchText, node.value]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}
