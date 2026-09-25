import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// @testing-library/react's auto-cleanup only self-registers when it detects
// Jest's global afterEach; under vitest (without `test.globals: true`) that
// hook doesn't fire, so each render() would otherwise leak into the next
// test's DOM. Register it explicitly instead.
afterEach(() => {
  cleanup();
});

// jsdom implements neither — PhotoUploader (and anything else previewing a
// freshly-selected File) calls both on every file selection.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:mock-url";
}
if (typeof URL.revokeObjectURL !== "function") {
  URL.revokeObjectURL = () => {};
}
