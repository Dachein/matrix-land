UPDATE user_identity_profiles
SET job_title = ''
WHERE job_title IS NOT NULL
  AND job_title != '';
