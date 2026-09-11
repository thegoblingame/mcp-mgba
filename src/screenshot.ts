import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Keep the saved screenshot untouched; enlarge only the inline presentation. */
export async function screenshotResult(path: string): Promise<CallToolResult> {
  const source = await readFile(path);
  const metadata = await sharp(source).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) {
    throw new Error("The bridge screenshot must be a valid PNG.");
  }
  const width = metadata.width * 3;
  const height = metadata.height * 3;
  const presented = await sharp(source)
    .resize(width, height, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer();
  return {
    content: [
      { type: "text", text: `Screenshot saved: ${path}\nNative: ${metadata.width}x${metadata.height}; inline: ${width}x${height} (3x nearest-neighbor).` },
      { type: "image", mimeType: "image/png", data: presented.toString("base64") },
    ],
  };
}
