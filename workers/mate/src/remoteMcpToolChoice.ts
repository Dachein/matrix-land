import { z } from 'zod';

// Auth tool fingerprints use SHA-256 encoded as unpadded Base64URL.
// Skill and approval action digests use a separate sha256:hex format.
export const remoteMcpToolChoiceSchema = z.strictObject({
  name: z.string().min(1).max(128),
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  readOnly: z.boolean()
});
