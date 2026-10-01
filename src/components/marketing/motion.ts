import type { CSSProperties } from "react";

/*
 * Motion helpers for server components on the public site. Plain functions (no "use client"), so any
 * server component can spread them. RevealRoot (reveal.tsx) does the observing.
 */

type RevealProps = { "data-reveal": string; style?: CSSProperties };

/** Scroll reveal: fades and lifts the element in when it enters the viewport. `delay` in ms staggers siblings. */
export function reveal(delay = 0, variant: "up" | "scale" = "up"): RevealProps {
  return {
    "data-reveal": variant === "scale" ? "scale" : "",
    ...(delay ? { style: { "--reveal-delay": `${delay}ms` } as CSSProperties } : {}),
  };
}

/** Load-time entrance delay for `animate-site-rise` / `animate-site-fade` (above-the-fold content). */
export function delay(ms: number): CSSProperties {
  return { "--d": `${ms}ms` } as CSSProperties;
}
