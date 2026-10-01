import { Instrument_Sans, Instrument_Serif } from "next/font/google";

/*
 * The public website's type theme. Loaded by the marketing layout only, so these files are preloaded on the
 * website and never on the terminal, console or tenant portal. `.site-theme` in globals.css maps them onto the
 * font tokens every component already uses. Mono stays IBM Plex Mono, which the root layout loads for everyone.
 */

/** Display serif for headlines; the italic carries the emphasis word in a heading. */
export const siteSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-site-serif",
  display: "swap",
});

/** Text face for the website: the full variable weight range (the app only loads 500 to 700). */
export const siteSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-site-sans",
  display: "swap",
});

/** Every class the website wrapper (and anything it portals, like the mobile menu) needs. */
export const SITE_FONT_CLASSES = `${siteSerif.variable} ${siteSans.variable}`;
