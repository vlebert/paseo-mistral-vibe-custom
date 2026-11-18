import type { PluginClientContext } from "@getpaseo/plugin/client";

// Usage info is shown via the composer context ring popover and the host usage modal,
// not as inline timeline items, so no client renderer is registered.
export default function contribute(_client: PluginClientContext) {
  return () => {};
}
