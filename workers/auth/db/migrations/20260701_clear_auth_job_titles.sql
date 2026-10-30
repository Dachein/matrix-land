UPDATE auth_users
SET job_title = ''
WHERE job_title IS NOT NULL
  AND job_title != '';

UPDATE auth_app_users
SET job_title = ''
WHERE job_title IS NOT NULL
  AND job_title != '';
