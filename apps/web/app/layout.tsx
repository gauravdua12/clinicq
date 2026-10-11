import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Fonts ship inside the build (OFL, from @fontsource-variable): no network at build time, no third-party requests at runtime.
const sora = localFont({ src: "../../../node_modules/@fontsource-variable/sora/files/sora-latin-wght-normal.woff2", weight: "100 800", variable: "--font-sora", display: "swap" });
const hanken = localFont({ src: "../../../node_modules/@fontsource-variable/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2", weight: "100 900", variable: "--font-hanken", display: "swap" });
const deva = localFont({ src: "../../../node_modules/@fontsource-variable/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-wght-normal.woff2", weight: "100 900", variable: "--font-deva", display: "swap" });

export const metadata: Metadata = { title: "ClinicQ", description: "Appointments, walk-ins and the token queue — on WhatsApp." };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#1d4ed8" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${hanken.variable} ${deva.variable}`}>
      <body>{children}</body>
    </html>
  );
}
