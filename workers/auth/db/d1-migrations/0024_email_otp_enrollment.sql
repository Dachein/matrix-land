-- A verified recipient can establish an ordinary account without a directory import.
-- Existing installations opt in explicitly; no existing users or policy are changed.
ALTER TABLE auth_email_otp_challenges ADD COLUMN recipient_ciphertext TEXT;
