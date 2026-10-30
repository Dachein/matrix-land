ALTER TABLE auth_app_clients
  ADD COLUMN collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE auth_app_clients
  ADD COLUMN system_role_policy_version TEXT NOT NULL DEFAULT '';

ALTER TABLE auth_resource_clients
  ADD COLUMN collaborator_user_ids_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE auth_resource_clients
  ADD COLUMN system_role_policy_version TEXT NOT NULL DEFAULT '';
