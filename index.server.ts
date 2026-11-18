import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createVibeCustomProvider } from "./server/provider.js";
import { createVibeUsageSource } from "./server/usage-source.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createVibeCustomProvider());
  // Feeds the host usage modal ("Agents Usage") with vibe's monthly budget percentage
  // plus session details. The composer context ring reads lastUsage directly.
  server.registerUsageSource(createVibeUsageSource());
  return () => {};
}
