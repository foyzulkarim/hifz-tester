import type { Metadata } from "next";
import { Amiri, Fraunces, Spectral } from "next/font/google";
import "./globals.css";

const amiri = Amiri({
  weight: ["400", "700"],
  subsets: ["arabic"],
  variable: "--font-arabic",
  display: "swap",
});

const fraunces = Fraunces({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const spectral = Spectral({
  weight: ["300", "400", "500"],
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hifz Tester",
  description: "A quiet listening teacher for Quran memorization.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${amiri.variable} ${fraunces.variable} ${spectral.variable}`}>
        {children}
      </body>
    </html>
  );
}
