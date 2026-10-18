import type { Metadata } from "next";
import { SettingsView } from "@/components/settings/SettingsView";
import { getSession } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  // reads the session cookies, so this page renders per request where operators sign in
  const session = await getSession();
  return <SettingsView account={session?.state === "signed-in" ? session.email : null} />;
}
