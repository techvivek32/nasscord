"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * Mounted once by the marketing layout. Marks every [data-reveal] element with data-shown when it scrolls into
 * view (once), which plays the CSS transition in globals.css. Re-scans after each client-side navigation.
 */
export function RevealRoot() {
  const pathname = usePathname();

  React.useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]:not([data-shown])"));
    if (els.length === 0) return;
    if (!("IntersectionObserver" in window)) {
      els.forEach((el) => el.setAttribute("data-shown", ""));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          // Also show anything already scrolled past (a jump to an anchor skips over it).
          if (!e.isIntersecting && e.boundingClientRect.top > 0) continue;
          e.target.setAttribute("data-shown", "");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pathname]);

  return null;
}

/**
 * A number that counts up from zero the first time it scrolls into view. The server renders the final value,
 * so the figure is right without scripting and for reduced motion.
 */
export function CountUp({ value, decimals = 0, prefix = "", suffix = "", duration = 1400, className }: { value: number; decimals?: number; prefix?: string; suffix?: string; duration?: number; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const format = React.useCallback((n: number) => `${prefix}${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`, [prefix, suffix, decimals]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    let frame = 0;
    let started = false;
    const run = () => {
      const t0 = performance.now();
      const tick = (t: number) => {
        const p = Math.min(1, (t - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = format(value * eased);
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting && !started) {
          started = true;
          run();
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, duration, format]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}

/** 125 -> "2:05". */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * A clock that runs from 0:00 up to `seconds` the first time it scrolls into view, shown as m:ss. The server renders
 * the final time, so it reads right without scripting and for reduced motion.
 */
export function ClockUp({ seconds, duration = 2200, className }: { seconds: number; duration?: number; className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    let frame = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / duration);
          el.textContent = mmss(seconds * (1 - Math.pow(1 - p, 2)));
          if (p < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [seconds, duration]);

  return (
    <span ref={ref} className={className}>
      {mmss(seconds)}
    </span>
  );
}
