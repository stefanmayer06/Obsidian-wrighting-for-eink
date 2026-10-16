/** The Excalidraw release in vendor/excalidraw, embedded by esbuild.config.mjs. */

declare module "vendored-excalidraw:main.js" {
  const code: string;
  export default code;
}

declare module "vendored-excalidraw:styles.css" {
  const css: string;
  export default css;
}

declare module "vendored-excalidraw:manifest.json" {
  const manifest: import("obsidian").PluginManifest;
  export default manifest;
}
