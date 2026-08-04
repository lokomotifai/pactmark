import { describe, expect, it } from "vitest";

import { isAccessRestrictedStatus } from "../../tooling/lib/external-links.mjs";

describe("external link status classification", () => {
  it.each([401, 403, 429])("reports HTTP %i as reachable but access-restricted", (status) => {
    expect(isAccessRestrictedStatus(status)).toBe(true);
  });

  it.each([200, 301, 404, 500])("does not hide HTTP %i as access-restricted", (status) => {
    expect(isAccessRestrictedStatus(status)).toBe(false);
  });
});
