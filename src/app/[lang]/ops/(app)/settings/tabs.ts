/** The settings sections and their addresses (shared by the server pages and the menu). */
export type SettingsTab = "profile" | "policies" | "content" | "villas" | "properties" | "access" | "integrations";
export const SETTINGS_PATHS: Record<SettingsTab, string> = { profile: "", policies: "/policies", content: "/content", villas: "/villas", properties: "/properties", access: "/access", integrations: "/integrations" };
/** Sections about one property (they sit under the property picker). */
export const SETTINGS_PER_PROPERTY: SettingsTab[] = ["profile", "policies", "content", "villas"];
