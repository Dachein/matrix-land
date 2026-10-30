import type { Mate } from "../types";
import { isAuthRequiredError } from "./auth";

/** The default identity is sufficient to enter chat; inventories are not prerequisites. */
export async function loadMateEntry(dependencies: {
  readDefault: () => Promise<Mate | null>;
  list: () => Promise<Mate[]>;
}): Promise<{ mate: Mate | null; mates?: Mate[] }> {
  try { return { mate: await dependencies.readDefault() }; }
  catch (error) {
    if (isAuthRequiredError(error)) throw error;
    const mates = await dependencies.list();
    const mate = mates.find((item) => item.isDefault && item.status !== "archived");
    if (!mate) throw error;
    return { mate, mates };
  }
}
