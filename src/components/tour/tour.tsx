"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { CircleHelpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ShellNavId } from "@/lib/nav";
import { tourFor, type TourStep } from "@/lib/tours";
import { hasSeenTour, markTourSeen, useTourStore } from "@/components/tour/store";

/** Space between the spotlight and the card, the card and the screen edge, and around the spotlighted element. */
const GAP = 12;
const MARGIN = 12;
const PAD = 6;
/** Wait for the page to mount its controls before the first-visit tour opens. */
const AUTO_START_MS = 900;

function isOnScreen(el: Element) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function resolveTarget(step: TourStep): Element | null {
  for (const selector of step.targets ?? []) {
    for (const el of document.querySelectorAll(selector)) if (isOnScreen(el)) return el;
  }
  return null;
}

/** Opens the tour for an area with the steps that apply to this role, page and screen width. */
export function startTour(id: ShellNavId) {
  const steps = tourFor(id).filter((s) => !s.optional || resolveTarget(s) !== null);
  useTourStore.getState().start(id, steps);
}

/** Header button that replays the area's tour. */
export function TourButton({ id }: { id: ShellNavId }) {
  return (
    <Button variant="ghost" size="icon" aria-label="Take the tour" title="Take the tour" data-tour="tour-button" onClick={() => startTour(id)}>
      <CircleHelpIcon />
    </Button>
  );
}

/**
 * The tour for one area. Mounted once by AppShell: opens by itself on the first visit to the area,
 * and whenever the TourButton asks for it.
 */
export function Tour({ id }: { id: ShellNavId }) {
  const active = useTourStore((s) => s.active === id);
  const steps = useTourStore((s) => s.steps);
  const index = useTourStore((s) => s.index);
  const next = useTourStore((s) => s.next);
  const back = useTourStore((s) => s.back);
  const stop = useTourStore((s) => s.stop);

  React.useEffect(() => {
    if (hasSeenTour(id)) return;
    const t = window.setTimeout(() => {
      markTourSeen(id);
      startTour(id);
    }, AUTO_START_MS);
    return () => window.clearTimeout(t);
  }, [id]);

  // Leaving the area ends its tour.
  React.useEffect(
    () => () => {
      if (useTourStore.getState().active === id) useTourStore.getState().stop();
    },
    [id],
  );

  const step = active ? steps[index] : undefined;
  if (!step) return null;
  return createPortal(<TourLayer key={index} step={step} index={index} total={steps.length} onNext={next} onBack={back} onClose={stop} />, document.body);
}

interface Layout {
  /** Spotlight box in viewport coordinates, or null when the step has nothing to point at. */
  spot: { top: number; left: number; width: number; height: number } | null;
  top: number;
  left: number;
}

/** Card position: beside the target when there is room (sidebar), else below, above or to the left; kept on screen. */
function place(spot: Layout["spot"], cw: number, ch: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = (vh - ch) / 2;
  let left = (vw - cw) / 2;
  if (spot) {
    const right = spot.left + spot.width;
    const bottom = spot.top + spot.height;
    if (vw - right >= cw + GAP + MARGIN) {
      left = right + GAP;
      top = spot.top;
    } else if (vh - bottom >= ch + GAP + MARGIN) {
      top = bottom + GAP;
      left = spot.left + spot.width / 2 - cw / 2;
    } else if (spot.top >= ch + GAP + MARGIN) {
      top = spot.top - GAP - ch;
      left = spot.left + spot.width / 2 - cw / 2;
    } else if (spot.left >= cw + GAP + MARGIN) {
      left = spot.left - GAP - cw;
      top = spot.top;
    } else {
      top = vh - ch - MARGIN;
    }
  }
  return {
    top: Math.round(Math.max(MARGIN, Math.min(top, vh - ch - MARGIN))),
    left: Math.round(Math.max(MARGIN, Math.min(left, vw - cw - MARGIN))),
  };
}

function TourLayer({ step, index, total, onNext, onBack, onClose }: { step: TourStep; index: number; total: number; onNext: () => void; onBack: () => void; onClose: () => void }) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const primaryRef = React.useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = React.useState<Layout | null>(null);
  const titleId = React.useId();
  const bodyId = React.useId();
  const last = index === total - 1;

  const measure = React.useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    const el = resolveTarget(step);
    let spot: Layout["spot"] = null;
    if (el) {
      const r = el.getBoundingClientRect();
      spot = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    }
    setLayout({ spot, ...place(spot, card.offsetWidth, card.offsetHeight) });
  }, [step]);

  // Bring the target into view, then measure on the next frame and again whenever the page moves.
  React.useEffect(() => {
    const el = resolveTarget(step);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: r.height > window.innerHeight ? "start" : "center" });
    }
    let frame = window.requestAnimationFrame(measure);
    const again = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    window.addEventListener("resize", again);
    window.addEventListener("scroll", again, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", again);
      window.removeEventListener("scroll", again, true);
    };
  }, [step, measure]);

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Escape closes, arrows move, and Tab stays inside the card while the tour is open.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onBack();
      } else if (e.key === "Tab") {
        const focusable = Array.from(cardRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
        if (focusable.length === 0) return;
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        const to = e.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : at === focusable.length - 1 || at === -1 ? 0 : at + 1;
        e.preventDefault();
        focusable[to].focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onNext, onBack, onClose]);

  return (
    <>
      {/* Blocks the page while the tour is open. It dims the page itself only when there is nothing to spotlight. */}
      <div aria-hidden="true" data-tour-layer="backdrop" className={layout && !layout.spot ? "fixed inset-0 z-70 bg-black/50" : "fixed inset-0 z-70"} />
      {layout?.spot ? (
        <div
          aria-hidden="true"
          data-tour-layer="spotlight"
          className="pointer-events-none fixed z-70 rounded-lg ring-[200vmax] ring-black/50 outline-2 outline-primary"
          style={{ top: layout.spot.top, left: layout.spot.left, width: layout.spot.width, height: layout.spot.height }}
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-layer="card"
        className="fixed z-70 max-h-[calc(100dvh-1.5rem)] w-88 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none"
        style={layout ? { top: layout.top, left: layout.left } : { top: 0, left: 0, visibility: "hidden" }}
      >
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase tabular">
          Step {index + 1} of {total}
        </p>
        <h2 id={titleId} className="mt-1 text-base font-semibold tracking-tight">
          {step.title}
        </h2>
        <p id={bodyId} className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          {step.body}
        </p>
        {step.items ? (
          <dl className="mt-3 grid gap-2 border-t border-border pt-3">
            {step.items.map((it) => (
              <div key={it.label} className="grid gap-0.5">
                <dt className="text-sm font-medium">{it.label}</dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">{it.text}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-2">
          {last ? (
            <span />
          ) : (
            <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onClose}>
              Skip tour
            </Button>
          )}
          <div className="flex items-center gap-2">
            {index > 0 ? (
              <Button variant="outline" size="sm" onClick={onBack}>
                Back
              </Button>
            ) : null}
            <Button ref={primaryRef} size="sm" onClick={onNext}>
              {last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
