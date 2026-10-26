"use client";

/** Same-origin JSON request with the CSRF token. Throws ApiError with the server's plain message. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown>) {
    super(message);
  }
}

function csrf() {
  const m = /(?:^|;\s*)gate_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1] as string) : "";
}

export async function api<T = Record<string, unknown>>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": csrf() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(typeof data.error === "string" ? data.error : "Something went wrong.", res.status, data);
  return data as T;
}

/** POST that returns a file and saves it. */
export async function download(path: string, body: unknown, fallbackName: string) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? "The download failed.", res.status, data);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
