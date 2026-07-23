import { describe, expect, it } from "vitest";

import { buildLocalDiffPreview } from "./local-diff-preview";

describe("buildLocalDiffPreview", () => {
  it("returns a compact local unified diff for an unsaved change", () => {
    const preview = buildLocalDiffPreview(
      "src/demo.ts",
      "const mode = 'before';\nconsole.log(mode);\n",
      "const mode = 'after';\nconsole.log(mode);\n",
    );

    expect(preview).toMatchObject({
      path: "src/demo.ts",
      changedLines: 2,
      truncated: false,
      lines: [
        { kind: "removed", text: "const mode = 'before';" },
        { kind: "added", text: "const mode = 'after';" },
        { kind: "context", text: "console.log(mode);" },
      ],
    });
  });

  it("does not create a preview for an unchanged local document", () => {
    expect(buildLocalDiffPreview("src/demo.ts", "same\n", "same\n")).toBe(null);
  });

  it("redacts credential-shaped values before the local panel receives them", () => {
    // Build the fixture in pieces so secret scanners cannot mistake a test
    // value for a credential. The resulting string still matches the redactor.
    const credentialLike = ["sk", "live", "example-nonsecret-value"].join("_");
    const preview = buildLocalDiffPreview(
      ".env",
      "TOKEN=old-value\n",
      `TOKEN=${credentialLike}\n`,
    );

    expect(preview?.lines.map((line) => line.text).join("\n")).toContain(
      "<redacted>",
    );
    expect(preview?.lines.map((line) => line.text).join("\n")).not.toContain(
      credentialLike,
    );
  });

  it("uses a content-free notice when a file is too large for a panel preview", () => {
    const large = "a".repeat(24_001);
    const preview = buildLocalDiffPreview("src/large.ts", large, `${large}b`);

    expect(preview).toEqual({
      path: "src/large.ts",
      changedLines: 1,
      truncated: true,
      lines: [
        {
          kind: "context",
          text: "Large local change detected — preview intentionally limited.",
        },
      ],
    });
  });
});
