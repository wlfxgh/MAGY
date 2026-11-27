import * as assert from "assert";
import * as vscode from "vscode";

suite("magy", () => {
    test("commands are registered", async () => {
        const extension = vscode.extensions.all.find((item) => item.packageJSON.name === "magy");
        assert.ok(extension);
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes("magy.importCursorChat"));
        assert.ok(commands.includes("magy.showHistory"));
        assert.ok(commands.includes("magy.newChat"));
        assert.ok(commands.includes("magy.addSelection"));
        assert.ok(commands.includes("magy.installRuntime"));
    });
});
