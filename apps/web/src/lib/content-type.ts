/** Content-Type for a stored file that has no recorded type of its own (page assets), by extension. */
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  txt: "text/plain",
};

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
}
