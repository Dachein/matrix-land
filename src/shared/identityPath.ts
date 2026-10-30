// Identity values remain unchanged in authorization and database records. Encode
// each value only at a path boundary; never replace characters or decode twice.
export function encodeIdentityPathSegment(value: string): string {
  if (typeof value !== "string" || !value.length || value.length > 180
    || /[\u0000-\u001f\u007f]/.test(value) || value === "." || value === "..") {
    throw new Error("identity_path_segment_invalid");
  }
  try {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
  } catch {
    throw new Error("identity_path_segment_invalid");
  }
}
