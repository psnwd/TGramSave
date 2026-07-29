import { zip } from "fflate";

/** Avoids collisions when two items resolve to the same filename inside one archive. */
export function uniqueZipEntryName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  let n = 2;
  let candidate = `${base} (${n})${ext}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${base} (${n})${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export function buildZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/** TS's DOM lib wants `BlobPart`'s typed-array views tied to a plain `ArrayBuffer`, not the generic `ArrayBufferLike` that `Uint8Array` results carry — this is always true at runtime for buffers we construct ourselves. */
export function toBlob(data: Uint8Array, type?: string): Blob {
  return new Blob([data as unknown as BlobPart], type ? { type } : undefined);
}
