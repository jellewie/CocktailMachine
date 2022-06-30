/**
 * @fileoverview Script for bundling the client into a single html file,
 * which is then placed in a string in /Arduino/client.h.
 * Run with `deno task build`.
 */

// @ts-expect-error
import {rollup} from "https://esm.sh/rollup@2.75.7?pin=v86";
// @ts-expect-error
import {importAssertionsPlugin} from "https://esm.sh/rollup-plugin-import-assert@2.1.0?pin=v86"
// @ts-expect-error
import {importAssertions} from "https://esm.sh/acorn-import-assertions@1.8.0?pin=v86";
// @ts-expect-error
import postcss from "https://deno.land/x/postcss@8.4.13/mod.js";
// @ts-expect-error
import {setCwd} from "https://deno.land/x/chdir_anywhere@v0.0.2/mod.js";
// @ts-expect-error
import {resolve, dirname} from "https://deno.land/std@0.146.0/path/mod.ts";
// @ts-expect-error
import {Language, minify} from "https://deno.land/x/minifier@v1.1.1/mod.ts";
// @ts-expect-error
import * as esbuild from "https://deno.land/x/esbuild@v0.14.48/mod.js"
setCwd();

function postCssInlineUrlsPlugin() {
	const urlRegex = /url\("?(.+)"?\)/d;
	return {
		postcssPlugin: "postcss-inline-urls",
		/**
		 * @param {{value: string}} decl
		 * @param {{result: {opts: {from: string}}}} param1
		 * @returns
		 */
		async Declaration(decl, {result}) {
			const from = result.opts.from;
			const match = decl.value.match(urlRegex);
			if (match && match[1]) {
				const url = match[1];
				if (url.startsWith("data:")) {
					// Already inline.
					return;
				}
				await new Promise(r => setTimeout(r, 100));

				const filePath = resolve(dirname(from), url);
				const file = await Deno.readTextFile(filePath);
				const base64 = btoa(file);
				let mediatype = "text/plain";
				if (url.endsWith(".svg")) {
					mediatype = "image/svg+xml";
				}
				decl.value = `url(data:${mediatype};base64,${base64})`;
			}
		}
	}
}

function postCssPlugin() {
	return {
		name: "postcss",
		/**
		 * @param {string} code
		 * @param {string} id
		 */
		async transform(code, id) {
			if (id.endsWith(".css")) {
				const processor = postcss([
					postCssInlineUrlsPlugin(),
				]);
				const result = await processor.process(code, {
					from: id,
					to: id,
				});
				return result.css;
			}
		}
	}
}

console.log("Building client...");
const bundle = await rollup({
	input: "../src/main.js",
	/**
	 * @param {{code: string, message: string}} message
	 */
	onwarn: message => {
		if (message.code == "CIRCULAR_DEPENDENCY") return;
		console.error(message.message);
	},
	acornInjectPlugins: [importAssertions],
	plugins: [
		postCssPlugin(),
		importAssertionsPlugin(),
	],
});
const {output} = await bundle.generate({
	format: "esm",
});

let htmlContent = await Deno.readTextFile("../src/index.html");

// Find "./main.js"
const mainJsIndex = htmlContent.indexOf("./main.js");
// Find the first "<script" occurrence before it
const scriptStartIndex = htmlContent.lastIndexOf("<script", mainJsIndex);
// Find the first "</script>" occurrence after it
const scriptEndIndex = htmlContent.indexOf("</script>", scriptStartIndex) + "</script>".length;
// Remove the script tag
htmlContent = htmlContent.slice(0, scriptStartIndex) + htmlContent.slice(scriptEndIndex);

console.log("Minifying js...");
const esbuildResult = await esbuild.transform(output[0].code, {
	loader: "js",
	minify: true,
});
const minifiedJs = esbuildResult.code;

// Inject an inline script tag with the build output before "<!--inline main.js inject position-->"
const injectIndex = htmlContent.indexOf("<!--inline main.js inject position-->");
htmlContent = htmlContent.slice(0, injectIndex) + `<script>${minifiedJs}</script>` + htmlContent.slice(injectIndex);

console.log("minifying html...");
const minifiedHtml = minify(Language.HTML, htmlContent);

// Write the output to dist.html so that we debug the client without having to build a new esp binary.
console.log("writing to dist.html");
await Deno.writeTextFile("../dist.html", minifiedHtml);

// Generate the Arduino client.h file
const clientH = `// This file is automatically generated by /Website/scripts/build.js
// To update it, run \`deno task build\`.

Const String HTML = "${minifiedHtml.replaceAll('"', '\\"')}";
`;

console.log("writing to client.h");
await Deno.writeTextFile("../../Arduino/client.h", clientH);
console.log("done!");
Deno.exit();
