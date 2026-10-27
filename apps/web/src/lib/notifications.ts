import { z } from "zod";

// Approvals in Slack and WhatsApp: request bodies for the settings routes, shared by the routes,
// the forms and tests. Elan1 Govern checks the values again; secrets go straight to it and are
// never stored or shown by the web app.

export const SlackBody = z
  .object({
    botToken: z.string().trim().regex(/^xoxb-[A-Za-z0-9-]{10,250}$/, "The bot token starts with xoxb-. Find it under OAuth & Permissions in your Slack app."),
    signingSecret: z.string().trim().regex(/^[a-f0-9]{16,128}$/, "The signing secret is under Basic Information → App Credentials in your Slack app."),
    channelId: z.string().trim().regex(/^[CG][A-Z0-9]{2,30}$/, "The channel ID looks like C0123456789. Open the channel's details in Slack to copy it."),
  })
  .strict();

const optionalName = z
  .string()
  .trim()
  .max(512)
  .regex(/^[a-z0-9_]*$/, "Template names use lowercase letters, numbers and underscores.")
  .optional()
  .transform((v) => (v ? v : undefined));

export const WhatsAppBody = z
  .object({
    phoneNumberId: z.string().trim().regex(/^\d{5,25}$/, "The phone-number ID is the long number under WhatsApp → API Setup (not the phone number)."),
    accessToken: z.string().trim().min(20, "Paste the full access token.").max(1000),
    appSecret: z.string().trim().regex(/^[a-f0-9]{16,128}$/, "The app secret is under App settings → Basic in your Meta app."),
    templateName: optionalName,
    templateLanguage: z
      .string()
      .trim()
      .regex(/^([a-z]{2,3}(_[A-Z]{2})?)?$/, "Use a language code like en or en_US.")
      .optional()
      .transform((v) => (v ? v : undefined)),
    verifyTemplateName: optionalName,
  })
  .strict();

export const NumberBody = z.object({ number: z.string().trim().min(6, "Enter the number with its country code.").max(30) }).strict();
export const CodeBody = z.object({ code: z.string().trim().regex(/^\d{6}$/, "The code is 6 digits.") }).strict();

/** "…3210": the only form of a number the console ever shows. */
export const maskedNumber = (last4: string) => `•••• ${last4}`;
