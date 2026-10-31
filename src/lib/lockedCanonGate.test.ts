import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LOCKED_POD_40_RULE } from "./lockedCanon.js";
import {
  CANON_CHANGE_LABEL,
  JOSH_GITHUB_LOGIN,
  canonChangeApprovedByJosh,
  evaluateLockedCanonGate,
  lockedDefinitionDrift,
} from "./lockedCanonGate.js";

const locked = `## LOCKED — Josh-only changes

Changes to this section require Josh's explicit approval. PRs that alter it must never auto-merge.

- ${LOCKED_POD_40_RULE}
`;

describe("D322 locked-canon merge gate", () => {
  it("a canon-consistent blurb does not count as a locked edit", () => {
    const base = `Canon as of **D320**.\n\n${locked}\n## Mission\n\nSend.\n`;
    const head = `Canon as of **D322**.\n\n**D322.** Gate.\n\n${locked}\n## Mission\n\nSend.\n`;
    const drift = lockedDefinitionDrift({
      baseCanon: base,
      headCanon: head,
      files: [
        {
          path: "docs/LOCKED-CANON.md",
          base: locked,
          head: locked,
        },
        {
          path: "src/lib/lockedCanon.ts",
          base: "export const LOCKED = true;\n",
          head: "export const LOCKED = true;\n",
        },
      ],
    });
    assert.equal(drift.lockedSectionChanged, false);
    assert.deepEqual(drift.definitionFilesChanged, []);
    const result = evaluateLockedCanonGate({
      ...drift,
      labels: [],
      reviews: [],
      labelEvents: [],
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /Canon-consistent/);
    assert.match(result.message, /not required/);
  });

  it("a locked-section edit fails without the canon-change label", () => {
    const drift = lockedDefinitionDrift({
      baseCanon: locked,
      headCanon: locked.replace(">=40", ">=30"),
      files: [],
    });
    assert.equal(drift.lockedSectionChanged, true);
    const result = evaluateLockedCanonGate({
      ...drift,
      labels: [],
      reviews: [{ login: JOSH_GITHUB_LOGIN, state: "APPROVED" }],
      labelEvents: [],
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Never auto-merge/);
  });

  it("a definition-file edit fails when someone else applied the label", () => {
    const result = evaluateLockedCanonGate({
      lockedSectionChanged: false,
      definitionFilesChanged: ["src/lib/lockedCanon.ts"],
      labels: [CANON_CHANGE_LABEL],
      reviews: [{ login: "cayden-design", state: "APPROVED" }],
      labelEvents: [
        {
          event: "labeled",
          label: CANON_CHANGE_LABEL,
          actor: "cayden-design",
        },
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /still need Josh/);
  });

  it("Josh applying the canon-change label authorizes the edit", () => {
    assert.equal(
      canonChangeApprovedByJosh({
        labels: [CANON_CHANGE_LABEL],
        reviews: [],
        labelEvents: [
          {
            event: "labeled",
            label: CANON_CHANGE_LABEL,
            actor: JOSH_GITHUB_LOGIN,
          },
        ],
      }),
      true,
    );
    const result = evaluateLockedCanonGate({
      lockedSectionChanged: true,
      definitionFilesChanged: ["docs/LOCKED-CANON.md"],
      labels: [CANON_CHANGE_LABEL],
      reviews: [],
      labelEvents: [
        {
          event: "labeled",
          label: CANON_CHANGE_LABEL,
          actor: JOSH_GITHUB_LOGIN,
        },
      ],
    });
    assert.equal(result.ok, true);
  });

  it("Josh's approving review authorizes a labeled edit", () => {
    const result = evaluateLockedCanonGate({
      lockedSectionChanged: true,
      definitionFilesChanged: [],
      labels: [CANON_CHANGE_LABEL],
      reviews: [
        { login: JOSH_GITHUB_LOGIN, state: "COMMENTED" },
        { login: JOSH_GITHUB_LOGIN, state: "APPROVED" },
      ],
      labelEvents: [
        {
          event: "labeled",
          label: CANON_CHANGE_LABEL,
          actor: "cayden-design",
        },
      ],
    });
    assert.equal(result.ok, true);
  });

  it("a later changes-requested review revokes the review path", () => {
    const result = evaluateLockedCanonGate({
      lockedSectionChanged: true,
      definitionFilesChanged: [],
      labels: [CANON_CHANGE_LABEL],
      reviews: [
        { login: JOSH_GITHUB_LOGIN, state: "APPROVED" },
        { login: JOSH_GITHUB_LOGIN, state: "CHANGES_REQUESTED" },
      ],
      labelEvents: [
        {
          event: "labeled",
          label: CANON_CHANGE_LABEL,
          actor: "cayden-design",
        },
      ],
    });
    assert.equal(result.ok, false);
  });

  it("removing the label after Josh applied it is not approval", () => {
    assert.equal(
      canonChangeApprovedByJosh({
        labels: [CANON_CHANGE_LABEL],
        reviews: [],
        labelEvents: [
          {
            event: "labeled",
            label: CANON_CHANGE_LABEL,
            actor: JOSH_GITHUB_LOGIN,
          },
          {
            event: "unlabeled",
            label: CANON_CHANGE_LABEL,
            actor: JOSH_GITHUB_LOGIN,
          },
          {
            event: "labeled",
            label: CANON_CHANGE_LABEL,
            actor: "cayden-design",
          },
        ],
      }),
      false,
    );
  });

  it("a missing base copy of a definition file is a locked edit", () => {
    const drift = lockedDefinitionDrift({
      baseCanon: null,
      headCanon: locked,
      files: [{ path: "src/lib/lockedCanon.ts", base: null, head: "x\n" }],
    });
    assert.equal(drift.lockedSectionChanged, true);
    assert.deepEqual(drift.definitionFilesChanged, ["src/lib/lockedCanon.ts"]);
  });
});
