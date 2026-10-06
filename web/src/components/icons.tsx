// The PolicyRouter mark: a gate with one signal passing through. Every other icon comes from
// @phosphor-icons/react.

import type { SVGProps } from "react";

export const Logo = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
    <path d="M7 4v16M17 4v16" />
    <path d="M3 12h4m10 0h4M7 12h3l1.5-3 1.5 6 1.5-3H17" />
  </svg>
);
