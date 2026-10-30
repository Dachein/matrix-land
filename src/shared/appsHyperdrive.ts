export const APPS_HYPERDRIVE_RESOURCE_TYPE = "hyperdrive_config" as const;
export const APPS_HYPERDRIVE_BINDING_NAME = "HYPERDRIVE" as const;
export const APPS_HYPERDRIVE_PASSWORD_SECRET_NAME = "HYPERDRIVE_PASSWORD" as const;

export type AppsHyperdriveScheme = "mysql" | "postgres" | "postgresql";

export type AppsHyperdriveDeploymentInput = {
  database: string;
  host: string;
  originConnectionLimit?: number;
  port?: number;
  scheme: AppsHyperdriveScheme;
  user: string;
};
