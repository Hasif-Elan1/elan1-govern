import { authedJson } from "./http";
import type { EgressHook } from "./types";
import type { Fetch, ProviderConfig } from "./oauth";
import { ConnectorError, type Connector, type ConnectorContext } from "./types";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_ATTACHMENT = 10 * 1024 * 1024;

interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const header = (p: Part | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const b64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function flatten(p: Part | undefined, out: Part[] = []): Part[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) flatten(c, out);
  return out;
}

/** Strip CR/LF so a header value can never start a new header. */
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function rawReply(to: string, subject: string, inReplyTo: string, body: string): string {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const msg = [
    `To: ${clean(to)}`,
    `Subject: ${clean(subj)}`,
    `In-Reply-To: ${clean(inReplyTo)}`,
    `References: ${clean(inReplyTo)}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(msg, "utf8").toString("base64url");
}

export function gmailConnector(cfg: ProviderConfig, f: Fetch = fetch, egress?: EgressHook): Connector {
  const get = (ctx: ConnectorContext, path: string) => authedJson("gmail", cfg, ctx, `${API}${path}`, { method: "GET", authScheme: "Bearer" }, f, egress) as Promise<Record<string, unknown>>;
  const post = (ctx: ConnectorContext, path: string, body: unknown) =>
    authedJson("gmail", cfg, ctx, `${API}${path}`, { method: "POST", authScheme: "Bearer", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, f, egress) as Promise<Record<string, unknown>>;

  const message = async (ctx: ConnectorContext, id: string) => {
    const m = (await get(ctx, `/messages/${encodeURIComponent(id)}?format=full`)) as { id: string; threadId: string; payload?: Part };
    const parts = flatten(m.payload);
    const text = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
    return {
      raw: m,
      data: {
        message_id: m.id,
        thread_id: m.threadId,
        from: header(m.payload, "From"),
        to: header(m.payload, "To"),
        subject: header(m.payload, "Subject"),
        date: header(m.payload, "Date"),
        body: text?.body?.data ? b64(text.body.data) : "",
        attachments: parts.filter((p) => p.filename && p.body?.attachmentId).map((p) => ({ attachment_id: p.body!.attachmentId!, filename: p.filename!, mime_type: p.mimeType ?? "application/octet-stream", size: p.body?.size ?? 0 })),
      },
    };
  };

  return {
    kind: "gmail",
    async call(tool: string, args, ctx) {
      switch (tool) {
        case "gmail.search": {
          const q = new URLSearchParams({ q: String(args.query ?? ""), maxResults: String(args.max_results ?? 10) });
          const list = (await get(ctx, `/messages?${q}`)) as { messages?: { id: string }[] };
          const messages = [];
          for (const { id } of list.messages ?? []) {
            const m = (await get(ctx, `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)) as { id: string; payload?: Part };
            messages.push({ message_id: m.id, from: header(m.payload, "From"), subject: header(m.payload, "Subject"), date: header(m.payload, "Date") });
          }
          return { data: { messages } };
        }
        case "gmail.read_message":
          return { data: (await message(ctx, String(args.message_id))).data };
        case "gmail.get_attachment": {
          const { data } = await message(ctx, String(args.message_id));
          const meta = data.attachments.find((a) => a.attachment_id === args.attachment_id);
          if (!meta) throw new ConnectorError("No such attachment", "not_found");
          if (meta.size > MAX_ATTACHMENT) throw new ConnectorError("Attachment is larger than 10 MB", "invalid");
          const a = (await get(ctx, `/messages/${encodeURIComponent(String(args.message_id))}/attachments/${encodeURIComponent(meta.attachment_id)}`)) as { data?: string };
          return { data: { ...meta, content_base64: Buffer.from(a.data ?? "", "base64url").toString("base64") } };
        }
        case "gmail.draft_reply":
        case "gmail.send_reply": {
          const { raw, data } = await message(ctx, String(args.message_id));
          const to = tool === "gmail.send_reply" ? String(args.to) : data.from;
          const encoded = rawReply(to, data.subject, header(raw.payload, "Message-ID"), String(args.body ?? ""));
          if (tool === "gmail.draft_reply") {
            const d = await post(ctx, "/drafts", { message: { raw: encoded, threadId: data.thread_id } });
            return { data: { draft_id: d.id }, ref: String(d.id) };
          }
          const s = await post(ctx, "/messages/send", { raw: encoded, threadId: data.thread_id });
          return { data: { sent_id: s.id }, ref: String(s.id) };
        }
        default:
          throw new ConnectorError(`Gmail does not handle ${tool}`, "invalid");
      }
    },
    async describe(_tool, args, ctx): Promise<Record<string, string>> {
      if (typeof args.message_id !== "string") return {};
      try {
        const m = (await get(ctx, `/messages/${encodeURIComponent(args.message_id)}?format=metadata&metadataHeaders=From`)) as { payload?: Part };
        const domain = /@([^>\s]+)/.exec(header(m.payload, "From"))?.[1];
        return domain ? { from_domain: domain.toLowerCase() } : {};
      } catch {
        return {};
      }
    },
    async evidence() {
      return {};
    },
    async vendorDomains() {
      return [];
    },
  };
}

export const __test = { rawReply, clean };
