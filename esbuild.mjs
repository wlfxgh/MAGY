import * as esbuild from "esbuild";
import { spawn } from "node:child_process";

const watch = process.argv.includes("--watch");
const withTsc = process.argv.includes("--with-tsc");

const buildOptions = {
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    outfile: "out/webview/ui.js",
    format: "iife",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    charset: "utf8",
    logLevel: "info",
};

if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    if (withTsc) {
        const tsc = spawn("npx", ["tsc", "-watch", "-p", "./"], {
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        const stop = async () => {
            tsc.kill();
            await ctx.dispose();
            process.exit(0);
        };
        process.on("SIGINT", () => void stop());
        process.on("SIGTERM", () => void stop());
    }
} else {
    await esbuild.build(buildOptions);
}
