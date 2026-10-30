export function isAppOwnerOrAdmin(
  principal: { sub: string; email?: string; role: string },
  ownerUserId: string
) {
  const aliases = [principal.sub, principal.email].filter((value): value is string => Boolean(value));
  return principal.role === "admin" || aliases.includes(ownerUserId);
}
