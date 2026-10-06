import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom doesn't implement scrolling
window.scrollTo = (() => undefined) as typeof window.scrollTo;
Element.prototype.scrollIntoView = () => undefined;
