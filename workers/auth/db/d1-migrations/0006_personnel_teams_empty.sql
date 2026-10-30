-- Personnel authorization uses the canonical department hierarchy only.
-- Portal workspace/team ownership is a separate concern and must not leak into
-- Auth directory users, App user snapshots, or MCP login snapshots.

DELETE FROM auth_user_memberships
WHERE target_type = 'team';

UPDATE auth_users
SET team_id = NULL,
    team_name = '',
    team_path_json = '[]',
    updated_at = CURRENT_TIMESTAMP
WHERE team_id IS NOT NULL
   OR trim(team_name) <> ''
   OR team_path_json <> '[]';

UPDATE auth_app_users
SET team_id = NULL,
    team_name = ''
WHERE team_id IS NOT NULL
   OR trim(team_name) <> '';

UPDATE auth_mcp_device_codes
SET user_team = NULL
WHERE trim(COALESCE(user_team, '')) <> '';

UPDATE auth_app_launch_codes
SET user_json = json_remove(user_json, '$.team', '$.teamId', '$.teamPath')
WHERE json_valid(user_json)
  AND (
    json_extract(user_json, '$.team') IS NOT NULL
    OR json_extract(user_json, '$.teamId') IS NOT NULL
    OR json_extract(user_json, '$.teamPath') IS NOT NULL
  );

CREATE TRIGGER IF NOT EXISTS trg_auth_users_personnel_team_empty_ai
AFTER INSERT ON auth_users
WHEN NEW.team_id IS NOT NULL
  OR trim(NEW.team_name) <> ''
  OR NEW.team_path_json <> '[]'
BEGIN
  UPDATE auth_users
  SET team_id = NULL,
      team_name = '',
      team_path_json = '[]'
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_users_personnel_team_empty_au
AFTER UPDATE OF team_id, team_name, team_path_json ON auth_users
WHEN NEW.team_id IS NOT NULL
  OR trim(NEW.team_name) <> ''
  OR NEW.team_path_json <> '[]'
BEGIN
  UPDATE auth_users
  SET team_id = NULL,
      team_name = '',
      team_path_json = '[]'
  WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_user_memberships_no_team_ai
AFTER INSERT ON auth_user_memberships
WHEN NEW.target_type = 'team'
BEGIN
  DELETE FROM auth_user_memberships
  WHERE user_id = NEW.user_id
    AND target_type = NEW.target_type
    AND target_id = NEW.target_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_user_memberships_no_team_au
AFTER UPDATE OF target_type ON auth_user_memberships
WHEN NEW.target_type = 'team'
BEGIN
  DELETE FROM auth_user_memberships
  WHERE user_id = NEW.user_id
    AND target_type = NEW.target_type
    AND target_id = NEW.target_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_app_users_personnel_team_empty_ai
AFTER INSERT ON auth_app_users
WHEN NEW.team_id IS NOT NULL OR trim(NEW.team_name) <> ''
BEGIN
  UPDATE auth_app_users
  SET team_id = NULL,
      team_name = ''
  WHERE app_id = NEW.app_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_app_users_personnel_team_empty_au
AFTER UPDATE OF team_id, team_name ON auth_app_users
WHEN NEW.team_id IS NOT NULL OR trim(NEW.team_name) <> ''
BEGIN
  UPDATE auth_app_users
  SET team_id = NULL,
      team_name = ''
  WHERE app_id = NEW.app_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_mcp_device_codes_personnel_team_empty_ai
AFTER INSERT ON auth_mcp_device_codes
WHEN trim(COALESCE(NEW.user_team, '')) <> ''
BEGIN
  UPDATE auth_mcp_device_codes
  SET user_team = NULL
  WHERE device_code = NEW.device_code;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_mcp_device_codes_personnel_team_empty_au
AFTER UPDATE OF user_team ON auth_mcp_device_codes
WHEN trim(COALESCE(NEW.user_team, '')) <> ''
BEGIN
  UPDATE auth_mcp_device_codes
  SET user_team = NULL
  WHERE device_code = NEW.device_code;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_app_launch_codes_personnel_team_empty_ai
AFTER INSERT ON auth_app_launch_codes
WHEN json_valid(NEW.user_json)
  AND (
    json_extract(NEW.user_json, '$.team') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamId') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamPath') IS NOT NULL
  )
BEGIN
  UPDATE auth_app_launch_codes
  SET user_json = json_remove(user_json, '$.team', '$.teamId', '$.teamPath')
  WHERE code_hash = NEW.code_hash;
END;

CREATE TRIGGER IF NOT EXISTS trg_auth_app_launch_codes_personnel_team_empty_au
AFTER UPDATE OF user_json ON auth_app_launch_codes
WHEN json_valid(NEW.user_json)
  AND (
    json_extract(NEW.user_json, '$.team') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamId') IS NOT NULL
    OR json_extract(NEW.user_json, '$.teamPath') IS NOT NULL
  )
BEGIN
  UPDATE auth_app_launch_codes
  SET user_json = json_remove(user_json, '$.team', '$.teamId', '$.teamPath')
  WHERE code_hash = NEW.code_hash;
END;
