-- Normalize legacy team-derived org slugs after removing the organization/space field
-- from the APPS app creation surface. Company tenancy remains org_id=example-org.

UPDATE apps_apps
SET org_slug = 'workspace-wealth',
    updated_at = datetime('now')
WHERE org_id = 'example-org'
  AND org_slug = 'ai-adoption';

UPDATE apps_app_resources
SET resource_name = 'apps-prod-workspace-wealth-' || substr(resource_name, length('apps-prod-ai-adoption-') + 1)
WHERE resource_name LIKE 'apps-prod-ai-adoption-%';

UPDATE apps_app_resources
SET resource_name = 'apps-preview-workspace-wealth-' || substr(resource_name, length('apps-preview-ai-adoption-') + 1)
WHERE resource_name LIKE 'apps-preview-ai-adoption-%';
