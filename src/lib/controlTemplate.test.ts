import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_CONTROL_BODY_TEXT,
  buildControlTemplate,
  controlChanged,
  defaultControlTemplate,
} from "./controlTemplate.js";

describe("control template versioning", () => {
  it("is a constant with no offer, link, or spam vocabulary", () => {
    const control = defaultControlTemplate();
    assert.match(control.controlVersion, /^ctl-[a-f0-9]{12}$/);
    assert.doesNotMatch(control.bodyText, /https?:\/\//i);
    assert.doesNotMatch(control.bodyText, /\bfree\b/i);
    assert.doesNotMatch(control.bodyText, /\bclick here\b/i);
    assert.match(control.bodyHtml, /<div>/);
    assert.equal(control.bodyText, DEFAULT_CONTROL_BODY_TEXT);
  });

  it("a casual edit is a new version", () => {
    const first = defaultControlTemplate();
    const second = buildControlTemplate(first.subject, `${first.bodyText}\n`);
    const third = buildControlTemplate("Different subject", first.bodyText);
    assert.equal(controlChanged(null, first), true);
    assert.equal(controlChanged(first, first), false);
    assert.equal(controlChanged(first, second), false);
    assert.equal(controlChanged(first, third), true);
    assert.notEqual(first.controlVersion, third.controlVersion);
  });
});
