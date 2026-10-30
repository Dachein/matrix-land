UPDATE skill_catalog_metadata
SET kind = 'vanilla'
WHERE kind = 'pure';

UPDATE skill_catalog_metadata
SET kind = 'app'
WHERE kind = 'mcp';

UPDATE skill_versions
SET artifact_type = 'skill_md'
WHERE artifact_type = 'skill_mcp';
