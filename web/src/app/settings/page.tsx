import type { Metadata } from "next";
import { SettingsView } from "@/components/settings/SettingsView";
import { getOperator } from "@/lib/auth";

// per request: the account section depends on the signed-in operator
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const operator = await getOperator();
  // no account section on the Pi, where there is no sign-in
  return <SettingsView account={operator && !operator.local ? operator.email : null} />;
}
