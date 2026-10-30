import workspaceMcpIcon from "../../assets/workspace-pass-mcp.svg";

export function WorkspaceMcpIcon({ size = 32 }: { size?: number }) {
  return <img alt="" aria-hidden="true" src={workspaceMcpIcon} width={size} height={size} />;
}

export function WorkspaceMcpBrand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "workspaceMcpBrand compact" : "workspaceMcpBrand"}>
      <WorkspaceMcpIcon size={compact ? 21 : 32} />
      <span>Workspace MCP</span>
    </span>
  );
}
