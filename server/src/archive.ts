import { createHash } from "node:crypto";

export const ARCHIVE_SHARD_ITEMS = 10_000;
export const HOT_ITEM_LIMIT = 50_000;
export const HOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ARCHIVE_ALARM_MS = 24 * 60 * 60 * 1000;

export type ArchiveItem = {
  seq: number;
  parent_seq: number | null;
  root_seq: number | null;
  actor: string;
  origin: string;
  client_id: string;
  kind: string;
  ts: number;
  body: string;
};

export type ArchivePostIndex = {
  post_seq: number;
  last_reply_seq: number;
  reply_count: number;
  bumped_at: number;
};

export type ArchiveRecord =
  | { type: "item"; row: ArchiveItem }
  | { type: "post_index"; row: ArchivePostIndex };

export function gzipJsonLines(next: () => Promise<string | null>): { stream: ReadableStream<Uint8Array>; getHash: () => string } {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const line = await next();
      if (line == null) controller.close();
      else controller.enqueue(encoder.encode(`${line}\n`));
    },
  });
  const digest = createHash("sha256");
  let hash = "";
  const stream = source.pipeThrough(new CompressionStream("gzip")).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      digest.update(chunk);
      controller.enqueue(chunk);
    },
    flush() { hash = digest.digest("hex"); },
  }));
  return { stream, getHash: () => hash };
}

export function archiveObjectKey(doKey: string, start: number, end: number): string {
  return `archive/${encodeURIComponent(doKey)}/${start}-${end}.ndjson.gz`;
}

export async function putArchiveStream(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  doKey: string,
  start: number,
  end: number,
): Promise<void> {
  const reader = stream.getReader();
  const partSize = 8 * 1024 * 1024;
  const parts: R2UploadedPart[] = [];
  const multipart: { upload?: R2MultipartUpload } = {};
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let partNumber = 1;
  const uploadPending = async (final: boolean) => {
    if (!pendingBytes || (!final && pendingBytes < partSize)) return;
    const bytes = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const chunk of pending) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    pending = [];
    pendingBytes = 0;
    if (!multipart.upload && final) {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
        customMetadata: { do_key: doKey, seq_start: String(start), seq_end: String(end) },
      });
      return;
    }
    multipart.upload ??= await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
      customMetadata: { do_key: doKey, seq_start: String(start), seq_end: String(end) },
    });
    parts.push(await multipart.upload.uploadPart(partNumber++, bytes));
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      if (pendingBytes >= partSize) await uploadPending(false);
    }
    await uploadPending(true);
    if (multipart.upload) await multipart.upload.complete(parts);
  } catch (error) {
    if (multipart.upload) await multipart.upload.abort().catch(() => {});
    throw error;
  }
}

export async function readGzipRecordsUntil(
  body: ReadableStream<Uint8Array>,
  onRecord: (record: ArchiveRecord) => boolean | Promise<boolean>,
): Promise<void> {
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const consumeLine = async (line: string): Promise<boolean> => {
    if (!line) return true;
    const record = JSON.parse(line) as ArchiveRecord;
    return onRecord(record);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!(await consumeLine(line))) {
        await reader.cancel();
        return;
      }
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending) await consumeLine(pending);
}

export async function readGzipJsonLines(
  body: ReadableStream<Uint8Array>,
  onRecord: (record: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const accept = (line: string) => {
    if (!line) return;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid snapshot record");
    onRecord(value as Record<string, unknown>);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      accept(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  if (pending) accept(pending);
}

export function searchableText(bodyJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(bodyJson);
  } catch {
    return "";
  }
  const fields: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === "string") fields.push(item);
    else if (Array.isArray(item)) for (const child of item) visit(child);
    else if (item && typeof item === "object") {
      const object = item as Record<string, unknown>;
      for (const key of ["title", "text", "preview", "alt"]) if (key in object) visit(object[key]);
    }
  };
  visit(value);
  return fields.join("\n").slice(0, 64 * 1024);
}

export function ftsQuery(value: string): string {
  const terms = value.normalize("NFC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 8) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}
