import * as assert from "assert";
import { getExtensionAPI } from "./extensionApi";
import type * as DescriptionEditorModule from "../descriptionEditor";

suite("descriptionEditor", () => {
  let editor: typeof DescriptionEditorModule;

  suiteSetup(async () => {
    ({ descriptionEditor: editor } = await getExtensionAPI());
  });

  test("combineDescriptions keeps every line of both descriptions", () => {
    assert.strictEqual(
      editor.combineDescriptions(
        "dest subject\n\ndest body\n",
        "src subject\nsrc body",
      ),
      "dest subject\n\ndest body\n\nsrc subject\nsrc body",
    );
    assert.strictEqual(
      editor.combineDescriptions("", "only source\n"),
      "only source",
    );
  });

  test("a description survives a round trip through the editor file", () => {
    const description = "subject\n\nfirst paragraph\nsecond line";
    const file = editor.buildDescriptionFile(description, ["Save to apply."]);
    assert.ok(file.includes("JJ: Save to apply."));
    assert.strictEqual(editor.stripDescriptionComments(file), description);
  });

  test("stripDescriptionComments handles CRLF and comment-only files", () => {
    assert.strictEqual(
      editor.stripDescriptionComments("subject\r\nJJ: note\r\nbody\r\n"),
      "subject\nbody",
    );
    assert.strictEqual(editor.stripDescriptionComments("\nJJ: only\n"), "");
  });
});
