UPDATE auth_users
SET role = 'admin',
    updated_at = CURRENT_TIMESTAMP
WHERE role = 'portal_admin';
