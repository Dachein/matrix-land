UPDATE user_identity_profiles
SET profile_json = '{"source":"seed","bio":"Builds the internal AI builder space, keeps launches visible, and helps teams turn useful workflows into governed apps and skills.","location":"Shanghai"}'
WHERE user_id = '00000000-0000-0000-0000-000000000001'
  AND profile_json IN ('{}', '{"source":"seed"}');

UPDATE user_identity_profiles
SET profile_json = '{"source":"seed","bio":"Reviews legal AI launches and translates policy requirements into reusable builder patterns.","location":"Beijing"}'
WHERE user_id = '00000000-0000-0000-0000-000000000002'
  AND profile_json IN ('{}', '{"source":"seed"}');

UPDATE user_identity_profiles
SET profile_json = '{"source":"seed","bio":"Helps teams package practical AI skills and measure adoption after launch.","location":"Shanghai"}'
WHERE user_id = '00000000-0000-0000-0000-000000000003'
  AND profile_json IN ('{}', '{"source":"seed"}');

UPDATE user_identity_profiles
SET profile_json = '{"source":"seed","bio":"Owns operations apps and turns incident patterns into productized copilot workflows.","location":"Shenzhen"}'
WHERE user_id = '00000000-0000-0000-0000-000000000004'
  AND profile_json IN ('{}', '{"source":"seed"}');

UPDATE user_identity_profiles
SET profile_json = '{"source":"seed","bio":"Connects revenue workflows with AI account intelligence and governed app launches.","location":"Hong Kong"}'
WHERE user_id = '00000000-0000-0000-0000-000000000005'
  AND profile_json IN ('{}', '{"source":"seed"}');
