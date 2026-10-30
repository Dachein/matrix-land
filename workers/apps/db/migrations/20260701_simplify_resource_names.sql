UPDATE apps_app_resources
SET resource_name =
  'apps-' ||
  (
    SELECT COALESCE(NULLIF(code, ''), NULLIF(slug, ''), apps_app_resources.app_id)
    FROM apps_apps
    WHERE apps_apps.id = apps_app_resources.app_id
  ) ||
  '-' ||
  CASE type
    WHEN 'pages_project' THEN 'pages'
    WHEN 'pages_function' THEN 'functions'
    WHEN 'worker' THEN 'worker'
    WHEN 'd1_database' THEN 'db'
    WHEN 'kv_namespace' THEN 'kv'
    WHEN 'r2_bucket' THEN 'r2'
    WHEN 'schema_registry' THEN 'schema'
    WHEN 'cron_trigger' THEN 'cron'
    WHEN 'queue' THEN 'queue'
    WHEN 'logs_audit' THEN 'audit'
    ELSE replace(type, '_', '-')
  END
WHERE EXISTS (
  SELECT 1
  FROM apps_apps
  WHERE apps_apps.id = apps_app_resources.app_id
);
