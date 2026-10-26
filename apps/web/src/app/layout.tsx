import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { cookies } from "next/headers";
import { Toaster } from "@/components/ui/toast";
import "./globals.css";

const sans = IBM_Plex_Sans({ subsets: ["latin", "latin-ext"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Gate", template: "%s · Gate" },
  description: "Rules, approvals and proof for AI agents that do real work.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbfa" },
    { media: "(prefers-color-scheme: dark)", color: "#15161b" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = (await cookies()).get("theme")?.value;
  const themeClass = theme === "dark" ? "dark" : theme === "light" ? "light" : "";
  return (
    <html lang="en-IN" className={`${sans.variable} ${mono.variable} ${themeClass}`}>
      <body>
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
