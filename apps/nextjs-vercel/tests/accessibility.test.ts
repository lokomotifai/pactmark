import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentConsole } from "../app/components/agent-console";

describe("Next UI accessibility", () => {
  it("exposes a keyboard-operable labeled flow and status announcements", () => {
    const html = renderToStaticMarkup(createElement(AgentConsole));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('for="fixture-item"');
    expect(html).toContain('id="fixture-item"');
    expect(html).toContain("Start run");
    expect(html).toContain("Reconnect");
    expect(html).toContain("Cancel");
    expect(html).toContain("Approval preview");
  });

  it("defines visible focus and reduced-motion behavior", async () => {
    const cssPath = fileURLToPath(new URL("../app/styles.css", import.meta.url));
    const css = await readFile(cssPath, "utf8");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 3px solid var(--focus)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
