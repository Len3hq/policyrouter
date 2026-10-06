// Client-side paths without a router library: history.pushState plus a change event, so moving
// between the landing page and the app keeps the wallet connection and doesn't reload.

import { useSyncExternalStore, type MouseEvent } from "react";

const CHANGE = "policyrouter:navigate";

const subscribe = (cb: () => void) => {
  addEventListener("popstate", cb);
  addEventListener(CHANGE, cb);
  return () => {
    removeEventListener("popstate", cb);
    removeEventListener(CHANGE, cb);
  };
};

/** The current path, without a trailing slash ("" for the root). */
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname.replace(/\/$/, ""));

export function navigate(path: string) {
  if (location.pathname + location.search === path) return;
  history.pushState(null, "", path);
  dispatchEvent(new Event(CHANGE));
  scrollTo(0, 0);
}

/** onClick for an <a href>: plain left clicks navigate in place; modified clicks (new tab etc.) behave normally. */
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute("href")!);
}
